import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { ProjectCommandProcess } from '../src/application/profile-check/index.js';
import {
  PublicationProbe,
  PublicationProbeError,
  ReadinessError,
  ReadinessFiles,
  ReadinessGit,
  ReadinessHost,
} from '../src/application/readiness/index.js';
import {
  PreviewLocationsError,
  previewRunLocations,
} from '../src/application/preview-run-locations/index.js';
import {
  RUNS_DIRECTORY_NAME,
  WORKTREES_DIRECTORY_NAME,
  isLegalGitBranchName,
  renderTaskBranch,
} from '../src/domain/run-locations.js';
import { EXIT_CODES } from '../src/domain/public-commands.js';
import { ReadinessFilesLive, ReadinessGitLive } from '../src/platform/readiness.js';
import { capableRoleHostLauncher } from './fixtures/role-host/role-host-launcher.js';

import type {
  PublicationProbeObservation,
  PublicationProbeRequest,
} from '../src/application/readiness/index.js';
import type { RoleHostLauncher } from '../src/application/role-conversations/index.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

function envelopeFrom(stdout: string) {
  return Schema.decodeUnknownSync(ReportEnvelopeJson)(stdout);
}

function expectPreviewEnvelope(stdout: string) {
  const envelope = envelopeFrom(stdout);
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) {
    throw new Error(`Expected a success envelope but received: ${stdout}`);
  }
  const data = envelope.data;
  if (!('source' in data)) {
    throw new Error(`Expected a preview envelope but received: ${stdout}`);
  }
  return { envelope, data };
}

function expectPreviewFailure(stdout: string) {
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

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

const TASK_ID = 'example-change';

function goldenDocument(
  targetRepository: string,
  overrides?: {
    readonly taskBranchPolicy?: string;
    readonly sourceBranch?: string;
    readonly decisionPublication?: {
      readonly remote: string;
      readonly draft: true;
      readonly maintainersCanModify: false;
    } | null;
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
      commandMs: 900000,
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
        bootstrap: ['npm', 'ci'],
        formatCheck: ['npm', 'run', 'format:check'],
        lint: ['npm', 'run', 'lint'],
        typecheck: ['npm', 'run', 'typecheck'],
        test: ['npm', 'test'],
        build: ['npm', 'run', 'build'],
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
    ...overrides,
  };
}

interface HostScript {
  readonly platform: string;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly gitVersionOutput: string;
  readonly missingTool: string | undefined;
}

interface FilesScript {
  readonly texts: ReadonlyMap<string, string>;
  readonly directories: ReadonlySet<string>;
  readonly markers: ReadonlySet<string>;
  readonly writable: ReadonlySet<string>;
}

interface GitScript {
  readonly insideWorkTree: boolean;
  readonly remotes: ReadonlyArray<string>;
  readonly lsRemoteStdout: string;
  readonly lsRemoteExit: number;
  readonly gitDir: string;
  readonly statusStdout: string;
  readonly checkIgnoreExit: number;
  readonly trackedStdout: string;
  readonly remoteUrlStdout: string;
  readonly remoteUrlExit: number;
}

interface PublicationScript {
  readonly provided: boolean;
  readonly observation: PublicationProbeObservation;
  readonly error: string | null;
}

interface FakeWorld {
  readonly host: HostScript;
  readonly files: FilesScript;
  readonly git: GitScript;
  readonly publication: PublicationScript;
}

interface BuiltWorld {
  readonly layer: Layer.Layer<
    | ReadinessHost
    | ReadinessFiles
    | ReadinessGit
    | ProjectCommandProcess
    | RoleHostLauncher
    | PublicationProbe
  >;
  readonly gitCalls: Array<{ readonly args: ReadonlyArray<string>; readonly cwd: string }>;
}

function publicationObservation(
  overrides: Partial<PublicationProbeObservation> = {},
): PublicationProbeObservation {
  return {
    repository: 'foundry/target',
    tokenPresent: true,
    push: true,
    collaboratorPermission: 'maintain',
    issueCommentReadable: true,
    tokenScopes: null,
    protectedBranches: ['main'],
    limitations: [],
    ...overrides,
  };
}

function defaultWorld(): FakeWorld {
  return {
    host: {
      platform: 'linux',
      nodeVersion: 'v24.14.0',
      npmVersion: '11.9.0',
      gitVersionOutput: 'git version 2.53.0\n',
      missingTool: undefined,
    },
    files: {
      texts: new Map([[CONFIG_PATH, JSON.stringify(goldenDocument(TARGET))]]),
      directories: new Set([CONFIG_DIR, TARGET, '/target/.git']),
      markers: new Set(),
      writable: new Set([TARGET]),
    },
    git: {
      insideWorkTree: true,
      remotes: ['origin'],
      lsRemoteStdout: `${COMMIT}\trefs/heads/main\n`,
      lsRemoteExit: 0,
      gitDir: '/target/.git',
      statusStdout: '',
      checkIgnoreExit: 0,
      trackedStdout: '',
      remoteUrlStdout: 'git@github.com:foundry/target.git\n',
      remoteUrlExit: 0,
    },
    publication: {
      provided: false,
      observation: publicationObservation(),
      error: null,
    },
  };
}

function publicationWorld(
  publication: Partial<PublicationScript> = {},
  git: Partial<GitScript> = {},
): FakeWorld {
  const world = defaultWorld();
  return {
    ...world,
    git: { ...world.git, ...git },
    publication: { ...world.publication, provided: true, ...publication },
  };
}

function withTexts(world: FakeWorld, texts: ReadonlyMap<string, string>): FakeWorld {
  return { ...world, files: { ...world.files, texts } };
}

const UnusedProcess = Layer.succeed(
  ProjectCommandProcess,
  ProjectCommandProcess.of({
    run: () => Effect.die(new Error('init must not run project commands')),
  }),
);

function buildWorld(
  world: FakeWorld,
  roleHostLayer: Layer.Layer<RoleHostLauncher> = capableRoleHostLauncher(),
): BuiltWorld {
  const gitCalls: BuiltWorld['gitCalls'] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(
      ReadinessHost,
      ReadinessHost.of({
        platform: Effect.succeed(world.host.platform),
        nodeVersion:
          world.host.missingTool === 'node'
            ? Effect.fail(
                new ReadinessError({
                  message: 'Missing required tool: Node.js. Expected 24.14.0.',
                }),
              )
            : Effect.succeed(world.host.nodeVersion),
        npmVersion:
          world.host.missingTool === 'npm'
            ? Effect.fail(
                new ReadinessError({
                  message: 'Missing required tool: npm. Expected 11.9.0.',
                }),
              )
            : Effect.succeed(world.host.npmVersion),
        gitVersionOutput:
          world.host.missingTool === 'git'
            ? Effect.fail(
                new ReadinessError({
                  message: 'Missing required tool: Git. Expected 2.43 or newer.',
                }),
              )
            : Effect.succeed(world.host.gitVersionOutput),
      }),
    ),
    Layer.succeed(
      ReadinessFiles,
      ReadinessFiles.of({
        readFile: (path: string) => {
          const text = world.files.texts.get(path);
          if (text === undefined) {
            return Effect.fail(
              new ReadinessError({
                message: `Cannot read configuration document at ${path}: file not found.`,
              }),
            );
          }
          return Effect.succeed(text);
        },
        statPath: (path: string) =>
          Effect.succeed(
            world.files.markers.has(path) || world.files.texts.has(path)
              ? { exists: true, isDirectory: false }
              : world.files.directories.has(path)
                ? { exists: true, isDirectory: true }
                : { exists: false, isDirectory: false },
          ),
        isWritable: (path: string) => Effect.succeed(world.files.writable.has(path)),
      }),
    ),
    Layer.succeed(
      ReadinessGit,
      ReadinessGit.of({
        run: (args: ReadonlyArray<string>, cwd: string) =>
          Effect.sync(() => {
            gitCalls.push({ args, cwd });
            const head = args[0];
            if (head === 'rev-parse' && args[1] === '--is-inside-work-tree') {
              return world.git.insideWorkTree
                ? { stdout: 'true\n', exitCode: 0 }
                : { stdout: 'fatal: not a git repository\n', exitCode: 128 };
            }
            if (head === 'remote' && args[1] === 'get-url') {
              return { stdout: world.git.remoteUrlStdout, exitCode: world.git.remoteUrlExit };
            }
            if (head === 'remote') {
              return {
                stdout: world.git.remotes.length === 0 ? '' : `${world.git.remotes.join('\n')}\n`,
                exitCode: 0,
              };
            }
            if (head === 'ls-remote') {
              return { stdout: world.git.lsRemoteStdout, exitCode: world.git.lsRemoteExit };
            }
            if (head === 'rev-parse' && args[1] === '--absolute-git-dir') {
              return { stdout: `${world.git.gitDir}\n`, exitCode: 0 };
            }
            if (head === 'status') {
              return { stdout: world.git.statusStdout, exitCode: 0 };
            }
            if (head === 'check-ignore') {
              return { stdout: '', exitCode: world.git.checkIgnoreExit };
            }
            if (head === 'ls-files') {
              return { stdout: world.git.trackedStdout, exitCode: 0 };
            }
            return { stdout: '', exitCode: 99 };
          }),
      }),
    ),
    UnusedProcess,
    roleHostLayer,
    world.publication.provided
      ? Layer.succeed(
          PublicationProbe,
          PublicationProbe.of({
            observe: (_request: PublicationProbeRequest) =>
              world.publication.error === null
                ? Effect.succeed(world.publication.observation)
                : Effect.fail(new PublicationProbeError({ message: world.publication.error })),
          }),
        )
      : Layer.empty,
  );
  return { layer, gitCalls };
}

function previewWith(world: FakeWorld, taskId: string = TASK_ID) {
  const built = buildWorld(world);
  return {
    built,
    preview: previewRunLocations({ configArg: CONFIG_ARG, cwd: CONFIG_DIR, taskId }).pipe(
      Effect.provide(built.layer),
    ),
  };
}

function expectReadOnlyGitCalls(gitCalls: BuiltWorld['gitCalls']) {
  const verbs = gitCalls.map((call) => call.args[0]);
  for (const forbidden of [
    'fetch',
    'checkout',
    'switch',
    'pull',
    'merge',
    'commit',
    'worktree',
    'clone',
  ]) {
    expect(verbs).not.toContain(forbidden);
  }
}

describe('run location vocabulary', () => {
  it('renders the task branch by replacing the single placeholder', () => {
    expect(renderTaskBranch('foundry/<task-id>', 'example-change')).toBe('foundry/example-change');
    expect(WORKTREES_DIRECTORY_NAME).toBe('worktrees');
    expect(RUNS_DIRECTORY_NAME).toBe('runs');
  });

  it('accepts ordinary branch names and rejects illegal git refs', () => {
    expect(isLegalGitBranchName('foundry/example-change')).toBe(true);
    expect(isLegalGitBranchName('main')).toBe(true);
    for (const illegal of [
      '',
      '@',
      '/leading',
      'trailing/',
      '.leading',
      'trailing.',
      'name.lock',
      'has..dots',
      'has@{brace',
      'has//slash',
      'has space',
      'has~tilde',
      'has^caret',
      'has:colon',
      'has?question',
      'has*star',
      'has[bracket',
      'has\\backslash',
      'has\x01control',
    ]) {
      expect(isLegalGitBranchName(illegal), illegal).toBe(false);
    }
  });
});

describe('preview run locations with fake services', () => {
  it.effect('reports source, branch, workspace, harness, and artifact root', () =>
    Effect.gen(function* () {
      const { built, preview } = previewWith(defaultWorld());
      const report = yield* preview;

      expect(report.taskId).toBe(TASK_ID);
      expect(report.source).toEqual({ remote: 'origin', branch: 'main', commit: COMMIT });
      expect(report.branch).toBe('foundry/example-change');
      expect(report.workspace).toBe('/target/.agent/worktrees/example-change');
      expect(report.roleHarness).toEqual({
        protocol: 'foundry-role-host-v1',
        command: ['foundry-role-host'],
      });
      expect(report.artifacts).toEqual({ root: '/target/.agent/runs' });
      expectReadOnlyGitCalls(built.gitCalls);
    }),
  );

  it.effect('fails on the same dirty tree doctor would catch', () =>
    Effect.gen(function* () {
      const world = defaultWorld();
      const { preview } = previewWith({
        ...world,
        git: { ...world.git, statusStdout: '?? scratch.txt\n' },
      });
      const error = yield* preview.pipe(Effect.flip);
      expect(error).toBeInstanceOf(ReadinessError);
      expect(error.message).toContain('is not clean');
    }),
  );

  it.effect('fails when the source remote or branch is unreachable', () =>
    Effect.gen(function* () {
      const world = defaultWorld();
      const missingRemote = previewWith({
        ...world,
        git: { ...world.git, remotes: ['upstream'] },
      });
      const remoteError = yield* missingRemote.preview.pipe(Effect.flip);
      expect(remoteError.message).toContain('Source remote "origin" is not configured');

      const missingBranch = previewWith({
        ...world,
        git: { ...world.git, lsRemoteStdout: '' },
      });
      const branchError = yield* missingBranch.preview.pipe(Effect.flip);
      expect(branchError.message).toContain('Source branch "main" is not reachable');
    }),
  );

  it.effect('fails when the rendered branch equals the source branch', () =>
    Effect.gen(function* () {
      const world = withTexts(
        defaultWorld(),
        new Map([
          [CONFIG_PATH, JSON.stringify(goldenDocument(TARGET, { taskBranchPolicy: '<task-id>' }))],
        ]),
      );
      const { preview } = previewWith(world, 'main');
      const error = yield* preview.pipe(Effect.flip);
      expect(error).toBeInstanceOf(PreviewLocationsError);
      expect(error.message).toContain('must not equal source branch');
    }),
  );

  it.effect('fails when the rendered branch is not a legal git ref', () =>
    Effect.gen(function* () {
      const { preview } = previewWith(defaultWorld(), 'bad..id');
      const error = yield* preview.pipe(Effect.flip);
      expect(error).toBeInstanceOf(PreviewLocationsError);
      expect(error.message).toContain('is not a legal Git branch name');
    }),
  );

  it.effect('fails closed when configured publication has no resolved protection evidence', () =>
    Effect.gen(function* () {
      const world = withTexts(
        defaultWorld(),
        new Map([
          [
            CONFIG_PATH,
            JSON.stringify(
              goldenDocument(TARGET, {
                decisionPublication: { remote: 'origin', draft: true, maintainersCanModify: false },
              }),
            ),
          ],
        ]),
      );
      const built = buildWorld(world);
      const error = yield* previewRunLocations({
        configArg: CONFIG_ARG,
        cwd: CONFIG_DIR,
        taskId: TASK_ID,
      }).pipe(Effect.provide(built.layer), Effect.flip);

      expect(error).toBeInstanceOf(PreviewLocationsError);
      expect(error.message).toContain('cannot be checked against GitHub protected branches');
      expectReadOnlyGitCalls(built.gitCalls);
    }),
  );

  it.effect('fails when the rendered branch collides with a GitHub protected branch', () =>
    Effect.gen(function* () {
      const world = withTexts(
        defaultWorld(),
        new Map([
          [
            CONFIG_PATH,
            JSON.stringify(
              goldenDocument(TARGET, {
                decisionPublication: { remote: 'origin', draft: true, maintainersCanModify: false },
              }),
            ),
          ],
        ]),
      );
      const built = buildWorld(world);
      const error = yield* previewRunLocations({
        configArg: CONFIG_ARG,
        cwd: CONFIG_DIR,
        taskId: TASK_ID,
        protection: { _tag: 'Known', protectedBranches: ['main', 'foundry/example-change'] },
      }).pipe(Effect.provide(built.layer), Effect.flip);

      expect(error).toBeInstanceOf(PreviewLocationsError);
      expect(error.message).toContain('collides with a protected branch');
      expectReadOnlyGitCalls(built.gitCalls);
    }),
  );

  it.effect('accepts configured publication when the probe resolves known protected branches', () =>
    Effect.gen(function* () {
      const world = withTexts(
        publicationWorld({
          observation: publicationObservation({ protectedBranches: ['main', 'release'] }),
        }),
        new Map([
          [
            CONFIG_PATH,
            JSON.stringify(
              goldenDocument(TARGET, {
                decisionPublication: { remote: 'origin', draft: true, maintainersCanModify: false },
              }),
            ),
          ],
        ]),
      );
      const built = buildWorld(world);
      const report = yield* previewRunLocations({
        configArg: CONFIG_ARG,
        cwd: CONFIG_DIR,
        taskId: TASK_ID,
      }).pipe(Effect.provide(built.layer));

      expect(report.branch).toBe('foundry/example-change');
      expectReadOnlyGitCalls(built.gitCalls);
    }),
  );

  it.effect('accepts a protected-branch probe that does not name the rendered branch', () =>
    Effect.gen(function* () {
      const world = withTexts(
        defaultWorld(),
        new Map([
          [
            CONFIG_PATH,
            JSON.stringify(
              goldenDocument(TARGET, {
                decisionPublication: { remote: 'origin', draft: true, maintainersCanModify: false },
              }),
            ),
          ],
        ]),
      );
      const built = buildWorld(world);
      const report = yield* previewRunLocations({
        configArg: CONFIG_ARG,
        cwd: CONFIG_DIR,
        taskId: TASK_ID,
        protection: { _tag: 'Known', protectedBranches: ['main', 'release'] },
      }).pipe(Effect.provide(built.layer));

      expect(report.branch).toBe('foundry/example-change');
      expectReadOnlyGitCalls(built.gitCalls);
    }),
  );

  it.effect('serves init --dry-run through the cli envelope', () =>
    Effect.gen(function* () {
      const built = buildWorld(defaultWorld());
      const result = yield* runCli([
        'init',
        '--dry-run',
        '--config',
        CONFIG_PATH,
        '--task-id',
        TASK_ID,
        '--json',
      ]).pipe(Effect.provide(built.layer));

      expect(result.exitCode).toBe(EXIT_CODES.reported);
      const { envelope, data } = expectPreviewEnvelope(result.stdout);
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.command).toBe('init');
      expect(data.taskId).toBe(TASK_ID);
      expect(data.branch).toBe('foundry/example-change');
      expect(data.workspace).toBe('/target/.agent/worktrees/example-change');
      expect(data.artifacts).toEqual({ root: '/target/.agent/runs' });
      expect(Object.keys(data).sort()).toEqual(
        ['artifacts', 'branch', 'roleHarness', 'source', 'taskId', 'workspace'].sort(),
      );
      expectReadOnlyGitCalls(built.gitCalls);
    }),
  );

  it.effect('presents the same preview facts in human output as in json output', () =>
    Effect.gen(function* () {
      const built = buildWorld(defaultWorld());
      const runInit = (argv: ReadonlyArray<string>) =>
        runCli(argv).pipe(Effect.provide(built.layer));
      const jsonResult = yield* runInit([
        'init',
        '--dry-run',
        '--config',
        CONFIG_PATH,
        '--task-id',
        TASK_ID,
        '--json',
      ]);
      const humanResult = yield* runInit([
        'init',
        '--dry-run',
        '--config',
        CONFIG_PATH,
        '--task-id',
        TASK_ID,
      ]);
      expect(jsonResult.exitCode).toBe(EXIT_CODES.reported);
      expect(humanResult.exitCode).toBe(EXIT_CODES.reported);

      const { data } = expectPreviewEnvelope(jsonResult.stdout);
      expect(humanResult.stdout).toContain(`data.taskId: ${data.taskId}`);
      expect(humanResult.stdout).toContain(`data.source.remote: ${data.source.remote}`);
      expect(humanResult.stdout).toContain(`data.source.branch: ${data.source.branch}`);
      expect(humanResult.stdout).toContain(`data.source.commit: ${data.source.commit}`);
      expect(humanResult.stdout).toContain(`data.branch: ${data.branch}`);
      expect(humanResult.stdout).toContain(`data.workspace: ${data.workspace}`);
      expect(humanResult.stdout).toContain(
        `data.roleHarness.protocol: ${data.roleHarness.protocol}`,
      );
      expect(humanResult.stdout).toContain(`data.artifacts.root: ${data.artifacts.root}`);
      expect(humanResult.stdout.endsWith('\n')).toBe(true);
    }),
  );

  it.effect('maps preview failures to exit code 2 with an invalid invocation error', () =>
    Effect.gen(function* () {
      const world = defaultWorld();
      const built = buildWorld({
        ...world,
        git: { ...world.git, statusStdout: '?? scratch.txt\n' },
      });
      const result = yield* runCli([
        'init',
        '--dry-run',
        '--config',
        CONFIG_PATH,
        '--task-id',
        TASK_ID,
        '--json',
      ]).pipe(Effect.provide(built.layer));

      expect(result.exitCode).toBe(EXIT_CODES.invalidInvocation);
      const envelope = expectPreviewFailure(result.stdout);
      expect(envelope.command).toBe('init');
      expect(envelope.error.kind).toBe('invalid_invocation');
      expect(envelope.error.retryable).toBe(false);
      expect(envelope.error.message).toContain('is not clean');
    }),
  );
});

function setupRealRepository(label: string) {
  const remote = mkdtempSync(join(tmpdir(), `foundry-preview-${label}-remote-`));
  const dir = mkdtempSync(join(tmpdir(), `foundry-preview-${label}-`));
  const scratch = mkdtempSync(join(tmpdir(), `foundry-preview-${label}-config-`));
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'preview@example.com'], {
    encoding: 'utf8',
  });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Foundry Preview'], { encoding: 'utf8' });
  writeFileSync(join(dir, 'README.md'), '# target\n');
  writeFileSync(join(dir, '.gitignore'), '.agent\n');
  execFileSync('git', ['-C', dir, 'add', 'README.md', '.gitignore'], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial'], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'push', '-u', 'origin', 'main'], { encoding: 'utf8' });
  return { dir, remote, scratch };
}

function writeRealConfig(home: string, target: string) {
  const configPath = join(home, 'foundry.config.json');
  writeFileSync(configPath, JSON.stringify(goldenDocument(target)));
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

const integrationHost = Layer.succeed(
  ReadinessHost,
  ReadinessHost.of({
    platform: Effect.succeed('linux'),
    nodeVersion: Effect.succeed('v24.14.0'),
    npmVersion: Effect.succeed('11.9.0'),
    gitVersionOutput: Effect.succeed('git version 2.53.0\n'),
  }),
);

const integrationLayer = Layer.mergeAll(
  integrationHost,
  ReadinessFilesLive,
  ReadinessGitLive,
  capableRoleHostLauncher(),
);

describe('preview against real temporary git repositories', () => {
  it.effect('succeeds twice without touching the checkout or creating worktrees and runs', () =>
    Effect.gen(function* () {
      const { dir, remote, scratch } = yield* Effect.sync(() => setupRealRepository('clean'));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          mkdirSync(join(dir, '.agent'), { recursive: true });
          const configPath = writeRealConfig(join(dir, '.agent'), dir);
          const beforeHead = realGit(dir, ['rev-parse', 'HEAD']).trim();
          const beforeBranch = realGit(dir, ['branch', '--show-current']).trim();
          const beforeStatus = realGit(dir, ['status', '--porcelain']);

          const first = yield* previewRunLocations({
            configArg: configPath,
            cwd: dir,
            taskId: TASK_ID,
          }).pipe(Effect.provide(integrationLayer));

          expect(first.taskId).toBe(TASK_ID);
          expect(first.source.remote).toBe('origin');
          expect(first.source.branch).toBe('main');
          expect(first.source.commit).toBe(beforeHead);
          expect(first.branch).toBe('foundry/example-change');
          expect(first.workspace).toBe(join(dir, '.agent', 'worktrees', TASK_ID));
          expect(first.roleHarness.protocol).toBe('foundry-role-host-v1');
          expect(first.artifacts.root).toBe(join(dir, '.agent', 'runs'));

          const second = yield* previewRunLocations({
            configArg: configPath,
            cwd: dir,
            taskId: TASK_ID,
          }).pipe(Effect.provide(integrationLayer));
          expect(second).toEqual(first);

          expect(realGit(dir, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
          expect(realGit(dir, ['branch', '--show-current']).trim()).toBe(beforeBranch);
          expect(realGit(dir, ['status', '--porcelain'])).toBe(beforeStatus);
          expect(existsSync(join(dir, '.agent', 'runs'))).toBe(false);
          expect(existsSync(join(dir, '.agent', 'worktrees'))).toBe(false);
        }),
        cleanupRealRepository([dir, remote, scratch]),
      );
    }),
  );

  it.effect('fails on untracked files without switching the checkout', () =>
    Effect.gen(function* () {
      const { dir, remote, scratch } = yield* Effect.sync(() => setupRealRepository('dirty'));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          writeFileSync(join(dir, 'scratch.txt'), 'uncommitted\n');
          const beforeBranch = realGit(dir, ['branch', '--show-current']).trim();
          mkdirSync(join(dir, '.agent'), { recursive: true });
          const configPath = writeRealConfig(join(dir, '.agent'), dir);

          const error = yield* previewRunLocations({
            configArg: configPath,
            cwd: dir,
            taskId: TASK_ID,
          }).pipe(Effect.provide(integrationLayer), Effect.flip);

          expect(error.message).toContain('is not clean');
          expect(realGit(dir, ['branch', '--show-current']).trim()).toBe(beforeBranch);
          expect(existsSync(join(dir, '.agent', 'runs'))).toBe(false);
        }),
        cleanupRealRepository([dir, remote, scratch]),
      );
    }),
  );
});
