import { describe, expect, it } from '@effect/vitest';
import { Duration, Effect, Fiber, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReportEnvelope, runCli } from '../src/cli/program.js';
import {
  ProfileCheckError,
  ProjectCommandProcess,
  checkProjectProfile,
} from '../src/application/profile-check/index.js';
import {
  ReadinessError,
  ReadinessFiles,
  ReadinessGit,
  ReadinessHost,
} from '../src/application/readiness/index.js';
import { RunHistoryStorage } from '../src/application/run-history/index.js';
import { RunIdentityStore } from '../src/application/run-identity/index.js';
import { EXIT_CODES } from '../src/domain/public-commands.js';
import { ProjectCommandProcessLive } from '../src/platform/commands.js';
import { ReadinessFilesLive, ReadinessGitLive } from '../src/platform/readiness.js';
import { capableRoleHostLauncher } from './fixtures/role-host/role-host-launcher.js';

import type { RoleHostLauncher } from '../src/application/role-conversations/index.js';

import type { ProjectCommandResult } from '../src/application/profile-check/index.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

function envelopeFrom(stdout: string) {
  return Schema.decodeUnknownSync(ReportEnvelopeJson)(stdout);
}

function expectProfileEnvelope(stdout: string) {
  const envelope = envelopeFrom(stdout);
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) {
    throw new Error(`Expected a success envelope but received: ${stdout}`);
  }
  const data = envelope.data;
  if (!('profileCheck' in data)) {
    throw new Error(`Expected a profile-check envelope but received: ${stdout}`);
  }
  return { envelope, data };
}

function expectProfileFailure(stdout: string) {
  const envelope = envelopeFrom(stdout);
  expect(envelope.ok).toBe(false);
  if (envelope.ok) {
    throw new Error(`Expected a failure envelope but received: ${stdout}`);
  }
  return envelope;
}

const CONFIG_DIR = '/work';

const CONFIG_ARG = 'foundry.config.json';

const CONFIG_PATH = '/work/foundry.config.json';

const TARGET = '/target';

const HEAD = '0123456789abcdef0123456789abcdef01234567';

const OTHER_HEAD = 'fedcba9876543210fedcba9876543210fedcba98';

function goldenDocument(
  targetRepository: string,
  overrides?: {
    readonly bootstrap?: ReadonlyArray<string> | null;
    readonly commands?: Record<string, ReadonlyArray<string>>;
    readonly commandMs?: number;
  },
) {
  return {
    schemaVersion: 1,
    targetRepository,
    sourceRemote: 'origin',
    sourceBranch: 'main',
    taskBranchPolicy: 'foundry/<task-id>',
    roleHarness: {
      protocol: 'foundry-role-host-v1',
      command: ['foundry-role-host'],
      environmentAllowlist: ['OPENAI_API_KEY'],
    },
    timeouts: {
      roleMs: 1800000,
      settleMs: 30000,
      pollMs: 100,
      commandMs: overrides?.commandMs ?? 900000,
      runtimeReadinessMs: 120000,
      cleanupMs: 30000,
      leaseMs: 60000,
    },
    retryBudgets: { architect: 1, coder: 2, tester: 1, reviewer: 1 },
    operationalRetryBudgets: { git: 2, runtime: 1, publication: 2, cleanup: 1 },
    limits: { maxParallelCoders: 4, maxCorrectionRounds: 2, maxControlRepairsPerAttempt: 1 },
    projectProfile: {
      guidancePaths: [],
      commands: {
        bootstrap:
          overrides?.bootstrap === undefined ? ['bootstrap-tool', 'up'] : overrides.bootstrap,
        formatCheck: ['fmt', '--check'],
        lint: ['lint-tool', '--strict'],
        typecheck: ['tsc', '--noEmit'],
        test: ['test-tool', 'run'],
        build: ['build-tool', 'all'],
        ...overrides?.commands,
      },
    },
    runtimeProfile: null,
    decisionPublication: null,
    artifacts: {
      retentionDays: 30,
      maxRequestBytes: 262144,
      maxGuidanceBytes: 1048576,
      maxRoleHandoffBytes: 262144,
      maxEvidenceBytes: 26214400,
      maxTerminalCaptureBytes: 10485760,
      maxRunBytes: 104857600,
      redactionPatterns: [],
    },
  };
}

interface MutableGitState {
  head: string;
  status: string;
}

type ProcessScript = (
  state: MutableGitState,
) => Effect.Effect<ProjectCommandResult, ProfileCheckError>;

const succeedScript = (mutate?: (state: MutableGitState) => void): ProcessScript => {
  return (state) =>
    Effect.sync(() => {
      mutate?.(state);
      return { exitCode: 0, stdout: '', stderr: '' };
    });
};

const exitScript = (exitCode: number): ProcessScript => {
  return (_state) =>
    Effect.succeed({ exitCode, stdout: `out ${exitCode}`, stderr: `err ${exitCode}` });
};

interface ProcessCall {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
}

interface GitCall {
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

interface BuiltProfileWorld {
  readonly layer: Layer.Layer<
    | ReadinessHost
    | ReadinessFiles
    | ReadinessGit
    | ProjectCommandProcess
    | RunIdentityStore
    | RunHistoryStorage
    | RoleHostLauncher
  >;
  readonly processCalls: Array<ProcessCall>;
  readonly gitCalls: Array<GitCall>;
  readonly gitState: MutableGitState;
}

function mustNotTouchRunStorage(operation: string) {
  return Effect.die(new Error(`Profile checks must not touch run storage (${operation}).`));
}

function buildProfileWorld(options: {
  readonly documentText: string;
  readonly insideWorkTree?: boolean;
  readonly head?: string;
  readonly status?: string;
  readonly scripts: ReadonlyArray<ProcessScript>;
}): BuiltProfileWorld {
  const insideWorkTree = options.insideWorkTree ?? true;
  const gitState: MutableGitState = {
    head: options.head ?? HEAD,
    status: options.status ?? '',
  };
  const processCalls: Array<ProcessCall> = [];
  const gitCalls: Array<GitCall> = [];
  let scriptIndex = 0;
  const layer = Layer.mergeAll(
    Layer.succeed(
      ReadinessHost,
      ReadinessHost.of({
        platform: Effect.succeed('linux'),
        nodeVersion: Effect.succeed('v24.14.0'),
        npmVersion: Effect.succeed('11.9.0'),
        gitVersionOutput: Effect.succeed('git version 2.53.0\n'),
      }),
    ),
    Layer.succeed(
      ReadinessFiles,
      ReadinessFiles.of({
        readFile: (path: string) => {
          if (path !== CONFIG_PATH) {
            return Effect.fail(
              new ReadinessError({
                message: `Cannot read configuration document at ${path}: file not found.`,
              }),
            );
          }
          return Effect.succeed(options.documentText);
        },
        statPath: (_path: string) => Effect.succeed({ exists: false, isDirectory: false }),
        isWritable: (_path: string) => Effect.succeed(false),
      }),
    ),
    Layer.succeed(
      ReadinessGit,
      ReadinessGit.of({
        run: (args: ReadonlyArray<string>, cwd: string) =>
          Effect.sync(() => {
            gitCalls.push({ args, cwd });
            if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
              return insideWorkTree
                ? { stdout: 'true\n', exitCode: 0 }
                : { stdout: 'fatal: not a git repository\n', exitCode: 128 };
            }
            if (args[0] === 'rev-parse') {
              return { stdout: `${gitState.head}\n`, exitCode: 0 };
            }
            if (args[0] === 'status') {
              return { stdout: gitState.status, exitCode: 0 };
            }
            return { stdout: '', exitCode: 99 };
          }),
      }),
    ),
    Layer.succeed(
      ProjectCommandProcess,
      ProjectCommandProcess.of({
        run: (options_: { readonly command: ReadonlyArray<string>; readonly cwd: string }) => {
          processCalls.push({ command: [...options_.command], cwd: options_.cwd });
          const script = options.scripts[scriptIndex];
          scriptIndex += 1;
          if (script === undefined) {
            return Effect.fail(
              new ProfileCheckError({ message: 'Unexpected project command started.' }),
            );
          }
          return script(gitState);
        },
      }),
    ),
    Layer.succeed(
      RunIdentityStore,
      RunIdentityStore.of({
        statPath: (_path: string) => mustNotTouchRunStorage('statPath'),
        readFileBytes: (_path: string) => mustNotTouchRunStorage('readFileBytes'),
        ensureParentDirectory: (_path: string) => mustNotTouchRunStorage('ensureParentDirectory'),
        createRunDirectoryExclusive: (_path: string, _runId: string) =>
          mustNotTouchRunStorage('createRunDirectoryExclusive'),
        writeFileBytes: (_path: string, _bytes: Uint8Array) =>
          mustNotTouchRunStorage('writeFileBytes'),
        removeDirectory: (_path: string) => mustNotTouchRunStorage('removeDirectory'),
      }),
    ),
    Layer.succeed(
      RunHistoryStorage,
      RunHistoryStorage.of({
        readHistoryFiles: (_runDirectory: string) => mustNotTouchRunStorage('readHistoryFiles'),
        commitHistory: (_options) => mustNotTouchRunStorage('commitHistory'),
        replaceDerivedReports: (_options) => mustNotTouchRunStorage('replaceDerivedReports'),
      }),
    ),
    capableRoleHostLauncher(),
  );
  return { layer, processCalls, gitCalls, gitState };
}

function checkWith(world: BuiltProfileWorld) {
  return checkProjectProfile({ configArg: CONFIG_ARG, cwd: CONFIG_DIR }).pipe(
    Effect.provide(world.layer),
  );
}

function expectNoHistoryMutation(gitCalls: Array<GitCall>) {
  const verbs = gitCalls.map((call) => call.args[0]);
  for (const forbidden of ['fetch', 'checkout', 'switch', 'pull', 'merge', 'commit', 'worktree']) {
    expect(verbs).not.toContain(forbidden);
  }
}

describe('profile-check with fake services', () => {
  it.effect('runs bootstrap then the five verification commands in order', () =>
    Effect.gen(function* () {
      const world = buildProfileWorld({
        documentText: JSON.stringify(goldenDocument(TARGET)),
        scripts: [
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
        ],
      });
      const report = yield* checkWith(world);

      expect(report.profileCheck).toBe('passed');
      expect(report.repository).toEqual({ path: TARGET });
      expect(report.commands.map((command) => command.name)).toEqual([
        'bootstrap',
        'formatCheck',
        'lint',
        'typecheck',
        'test',
        'build',
      ]);
      expect(world.processCalls.map((call) => call.command)).toEqual([
        ['bootstrap-tool', 'up'],
        ['fmt', '--check'],
        ['lint-tool', '--strict'],
        ['tsc', '--noEmit'],
        ['test-tool', 'run'],
        ['build-tool', 'all'],
      ]);
      for (const call of world.processCalls) {
        expect(call.cwd).toBe(TARGET);
      }
      for (const command of report.commands) {
        expect(command.exitCode).toBe(0);
      }
      expectNoHistoryMutation(world.gitCalls);
    }),
  );

  it.effect('skips bootstrap when it is null', () =>
    Effect.gen(function* () {
      const world = buildProfileWorld({
        documentText: JSON.stringify(goldenDocument(TARGET, { bootstrap: null })),
        scripts: [
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
        ],
      });
      const report = yield* checkWith(world);

      expect(report.commands.map((command) => command.name)).toEqual([
        'formatCheck',
        'lint',
        'typecheck',
        'test',
        'build',
      ]);
      expect(world.processCalls).toHaveLength(5);
    }),
  );

  it.effect('resolves executables with a separator from the configuration directory', () =>
    Effect.gen(function* () {
      const world = buildProfileWorld({
        documentText: JSON.stringify(
          goldenDocument(TARGET, { bootstrap: ['./scripts/boot', 'up'] }),
        ),
        scripts: [
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
        ],
      });
      const report = yield* checkWith(world);

      expect(world.processCalls[0]?.command).toEqual(['/work/scripts/boot', 'up']);
      expect(world.processCalls[0]?.cwd).toBe(TARGET);
      expect(report.commands[0]?.command).toEqual(['/work/scripts/boot', 'up']);
    }),
  );

  it.effect('fails when a command changes tracked state even on exit zero', () =>
    Effect.gen(function* () {
      const world = buildProfileWorld({
        documentText: JSON.stringify(goldenDocument(TARGET)),
        scripts: [
          succeedScript(),
          succeedScript((state) => {
            state.status = ' M tracked.txt\n';
          }),
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
        ],
      });
      const error = yield* checkWith(world).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProfileCheckError);
      expect(error.message).toContain('"formatCheck"');
      expect(error.message).toContain('tracked');
      expect(world.processCalls).toHaveLength(2);
      expectNoHistoryMutation(world.gitCalls);
    }),
  );

  it.effect('fails when a command moves HEAD', () =>
    Effect.gen(function* () {
      const world = buildProfileWorld({
        documentText: JSON.stringify(goldenDocument(TARGET)),
        scripts: [
          succeedScript((state) => {
            state.head = OTHER_HEAD;
          }),
        ],
      });
      const error = yield* checkWith(world).pipe(Effect.flip);

      expect(error.message).toContain('"bootstrap"');
      expect(error.message).toContain('tracked Git state');
      expect(world.processCalls).toHaveLength(1);
    }),
  );

  it.effect('fails on a non-zero exit without starting later commands', () =>
    Effect.gen(function* () {
      const world = buildProfileWorld({
        documentText: JSON.stringify(goldenDocument(TARGET)),
        scripts: [exitScript(1)],
      });
      const error = yield* checkWith(world).pipe(Effect.flip);

      expect(error.message).toContain('"bootstrap"');
      expect(error.message).toContain('code 1');
      expect(world.processCalls).toHaveLength(1);
    }),
  );

  it.effect('fails when a command cannot start without starting later commands', () =>
    Effect.gen(function* () {
      const world = buildProfileWorld({
        documentText: JSON.stringify(goldenDocument(TARGET)),
        scripts: [
          (_state) =>
            Effect.fail(
              new ProfileCheckError({
                message: 'Cannot start project command "bootstrap-tool": spawn ENOENT.',
              }),
            ),
        ],
      });
      const error = yield* checkWith(world).pipe(Effect.flip);

      expect(error.message).toContain('Cannot start project command');
      expect(world.processCalls).toHaveLength(1);
    }),
  );

  it.effect('fails when a command exceeds the timeout and terminates the child', () =>
    Effect.gen(function* () {
      let terminated = false;
      const world = buildProfileWorld({
        documentText: JSON.stringify(goldenDocument(TARGET, { commandMs: 1000 })),
        scripts: [
          (_state) =>
            Effect.ensuring(
              Effect.never,
              Effect.sync(() => {
                terminated = true;
              }),
            ),
        ],
      });
      const fiber = yield* checkWith(world).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.millis(5000));
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ProfileCheckError);
      expect(error.message).toContain('"bootstrap"');
      expect(error.message).toContain('timed out');
      expect(terminated).toBe(true);
      expect(world.processCalls).toHaveLength(1);
    }),
  );

  it.effect('fails before any command on invalid configuration', () =>
    Effect.gen(function* () {
      const invalidJson = buildProfileWorld({
        documentText: '{not json',
        scripts: [succeedScript()],
      });
      const jsonError = yield* checkWith(invalidJson).pipe(Effect.flip);
      expect(jsonError.message).toContain('is not valid JSON');
      expect(invalidJson.processCalls).toHaveLength(0);

      const invalidSchema = buildProfileWorld({
        documentText: JSON.stringify({ ...goldenDocument(TARGET), schemaVersion: 999 }),
        scripts: [succeedScript()],
      });
      const schemaError = yield* checkWith(invalidSchema).pipe(Effect.flip);
      expect(schemaError.message).toContain('Invalid project configuration');
      expect(invalidSchema.processCalls).toHaveLength(0);
    }),
  );

  it.effect('fails before any command when the target is not a git work tree', () =>
    Effect.gen(function* () {
      const world = buildProfileWorld({
        documentText: JSON.stringify(goldenDocument(TARGET)),
        insideWorkTree: false,
        scripts: [succeedScript()],
      });
      const error = yield* checkWith(world).pipe(Effect.flip);

      expect(error.message).toContain('is not a Git work tree');
      expect(world.processCalls).toHaveLength(0);
    }),
  );

  it.effect('serves profile-check through the cli envelope without creating a live run', () =>
    Effect.gen(function* () {
      const world = buildProfileWorld({
        documentText: JSON.stringify(goldenDocument(TARGET, { bootstrap: null })),
        scripts: [
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
        ],
      });
      const result = yield* runCli(['profile-check', '--config', CONFIG_PATH, '--json']).pipe(
        Effect.provide(world.layer),
      );

      expect(result.exitCode).toBe(EXIT_CODES.reported);
      const { envelope, data } = expectProfileEnvelope(result.stdout);
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.command).toBe('profile-check');
      expect(data.profileCheck).toBe('passed');
      expect(data.repository).toEqual({ path: TARGET });
      expect(data.commands.map((command) => command.name)).toEqual([
        'formatCheck',
        'lint',
        'typecheck',
        'test',
        'build',
      ]);
      expect(Object.keys(data).sort()).toEqual(['commands', 'profileCheck', 'repository'].sort());
      expect('runId' in data).toBe(false);
      expectNoHistoryMutation(world.gitCalls);
    }),
  );

  it.effect('presents the same profile-check facts in human output as in json output', () =>
    Effect.gen(function* () {
      const world = buildProfileWorld({
        documentText: JSON.stringify(goldenDocument(TARGET, { bootstrap: null })),
        scripts: [
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
        ],
      });
      const runProfileCheck = (argv: ReadonlyArray<string>) =>
        runCli(argv).pipe(Effect.provide(world.layer));
      const jsonResult = yield* runProfileCheck([
        'profile-check',
        '--config',
        CONFIG_PATH,
        '--json',
      ]);
      const { data } = expectProfileEnvelope(jsonResult.stdout);

      const fresh = buildProfileWorld({
        documentText: JSON.stringify(goldenDocument(TARGET, { bootstrap: null })),
        scripts: [
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
          succeedScript(),
        ],
      });
      const humanResult = yield* runCli(['profile-check', '--config', CONFIG_PATH]).pipe(
        Effect.provide(fresh.layer),
      );
      expect(humanResult.exitCode).toBe(EXIT_CODES.reported);
      expect(humanResult.stdout).toContain('data.profileCheck: passed');
      expect(humanResult.stdout).toContain(`data.repository.path: ${data.repository.path}`);
      for (const command of data.commands) {
        expect(humanResult.stdout).toContain(command.name);
      }
      expect(humanResult.stdout.endsWith('\n')).toBe(true);
    }),
  );

  it.effect('maps profile-check failures to exit code 2 with an invalid invocation error', () =>
    Effect.gen(function* () {
      const world = buildProfileWorld({
        documentText: JSON.stringify(goldenDocument(TARGET)),
        scripts: [exitScript(3)],
      });
      const result = yield* runCli(['profile-check', '--config', CONFIG_PATH, '--json']).pipe(
        Effect.provide(world.layer),
      );

      expect(result.exitCode).toBe(EXIT_CODES.invalidInvocation);
      const envelope = expectProfileFailure(result.stdout);
      expect(envelope.command).toBe('profile-check');
      expect(envelope.error.kind).toBe('invalid_invocation');
      expect(envelope.error.retryable).toBe(false);
      expect(envelope.error.message).toContain('"bootstrap"');
    }),
  );
});

function setupRealRepository(label: string) {
  const remote = mkdtempSync(join(tmpdir(), `foundry-profile-${label}-remote-`));
  const dir = mkdtempSync(join(tmpdir(), `foundry-profile-${label}-`));
  const scratch = mkdtempSync(join(tmpdir(), `foundry-profile-${label}-config-`));
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'profile@example.com'], {
    encoding: 'utf8',
  });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Foundry Profile'], { encoding: 'utf8' });
  writeFileSync(join(dir, 'README.md'), '# target\n');
  writeFileSync(join(dir, 'tracked.txt'), 'tracked\n');
  writeFileSync(join(dir, '.gitignore'), '.agent\n');
  execFileSync('git', ['-C', dir, 'add', 'README.md', 'tracked.txt', '.gitignore'], {
    encoding: 'utf8',
  });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial'], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'push', '-u', 'origin', 'main'], { encoding: 'utf8' });
  return { dir, remote, scratch };
}

function writeRealConfig(
  home: string,
  target: string,
  commands: Record<string, ReadonlyArray<string> | null>,
) {
  const configPath = join(home, 'foundry.config.json');
  const document = goldenDocument(target);
  writeFileSync(
    configPath,
    JSON.stringify({
      ...document,
      projectProfile: {
        guidancePaths: [],
        commands: { ...document.projectProfile.commands, ...commands },
      },
    }),
  );
  return configPath;
}

function cleanupRealRepository(paths: ReadonlyArray<string>) {
  return Effect.sync(() => {
    for (const path of paths) {
      rmSync(path, { recursive: true, force: true });
    }
  });
}

function realGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

const integrationLayer = Layer.mergeAll(
  ReadinessFilesLive,
  ReadinessGitLive,
  ProjectCommandProcessLive,
);

const literalArgvCommand = (marker: string): ReadonlyArray<string> => [
  process.execPath,
  '-e',
  `process.exit(process.argv[1] === ${JSON.stringify(marker)} ? 0 : 1)`,
  marker,
];

describe('profile-check against real temporary git repositories', () => {
  it.effect('runs a real argv vector without a shell and leaves the checkout clean', () =>
    Effect.gen(function* () {
      const { dir, remote, scratch } = yield* Effect.sync(() => setupRealRepository('clean'));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          mkdirSync(join(dir, '.agent'), { recursive: true });
          const marker = 'a;b|c$d e';
          const vector = literalArgvCommand(marker);
          const configPath = writeRealConfig(join(dir, '.agent'), dir, {
            bootstrap: null,
            formatCheck: vector,
            lint: vector,
            typecheck: vector,
            test: vector,
            build: vector,
          });
          const beforeHead = realGit(dir, ['rev-parse', 'HEAD']).trim();
          const beforeBranch = realGit(dir, ['branch', '--show-current']).trim();
          const beforeStatus = realGit(dir, ['status', '--porcelain']);

          const report = yield* checkProjectProfile({ configArg: configPath, cwd: dir }).pipe(
            Effect.provide(integrationLayer),
          );

          expect(report.profileCheck).toBe('passed');
          expect(report.repository).toEqual({ path: dir });
          expect(report.commands.map((command) => command.name)).toEqual([
            'formatCheck',
            'lint',
            'typecheck',
            'test',
            'build',
          ]);
          expect(realGit(dir, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
          expect(realGit(dir, ['branch', '--show-current']).trim()).toBe(beforeBranch);
          expect(realGit(dir, ['status', '--porcelain'])).toBe(beforeStatus);
          expect(existsSync(join(dir, '.agent', 'runs'))).toBe(false);
        }),
        cleanupRealRepository([dir, remote, scratch]),
      );
    }),
  );

  it.effect('fails when a real command appends to a tracked file', () =>
    Effect.gen(function* () {
      const { dir, remote, scratch } = yield* Effect.sync(() => setupRealRepository('dirty'));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          mkdirSync(join(dir, '.agent'), { recursive: true });
          const probe: ReadonlyArray<string> = [process.execPath, '--version'];
          const configPath = writeRealConfig(join(dir, '.agent'), dir, {
            bootstrap: null,
            formatCheck: [
              process.execPath,
              '-e',
              'require("node:fs").appendFileSync("tracked.txt", "more\\n")',
            ],
            lint: probe,
            typecheck: probe,
            test: probe,
            build: probe,
          });
          const beforeHead = realGit(dir, ['rev-parse', 'HEAD']).trim();
          const beforeBranch = realGit(dir, ['branch', '--show-current']).trim();

          const error = yield* checkProjectProfile({ configArg: configPath, cwd: dir }).pipe(
            Effect.provide(integrationLayer),
            Effect.flip,
          );

          expect(error).toBeInstanceOf(ProfileCheckError);
          expect(error.message).toContain('"formatCheck"');
          expect(error.message).toContain('tracked Git state');
          expect(realGit(dir, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
          expect(realGit(dir, ['branch', '--show-current']).trim()).toBe(beforeBranch);
          expect(existsSync(join(dir, '.agent', 'runs'))).toBe(false);
        }),
        cleanupRealRepository([dir, remote, scratch]),
      );
    }),
  );

  it.effect('passes when a real command creates only untracked files', () =>
    Effect.gen(function* () {
      const { dir, remote, scratch } = yield* Effect.sync(() => setupRealRepository('untracked'));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          mkdirSync(join(dir, '.agent'), { recursive: true });
          const probe: ReadonlyArray<string> = [process.execPath, '--version'];
          const configPath = writeRealConfig(join(dir, '.agent'), dir, {
            bootstrap: null,
            formatCheck: [
              process.execPath,
              '-e',
              'require("node:fs").writeFileSync("untracked-output.txt", "scratch\\n")',
            ],
            lint: probe,
            typecheck: probe,
            test: probe,
            build: probe,
          });
          const beforeHead = realGit(dir, ['rev-parse', 'HEAD']).trim();

          const report = yield* checkProjectProfile({ configArg: configPath, cwd: dir }).pipe(
            Effect.provide(integrationLayer),
          );

          expect(report.profileCheck).toBe('passed');
          expect(existsSync(join(dir, 'untracked-output.txt'))).toBe(true);
          expect(realGit(dir, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
          expect(existsSync(join(dir, '.agent', 'runs'))).toBe(false);
        }),
        cleanupRealRepository([dir, remote, scratch]),
      );
    }),
  );
});
