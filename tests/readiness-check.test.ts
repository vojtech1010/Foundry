import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { RoleHostCapabilityError } from '../src/application/role-conversations/index.js';
import { ProjectCommandProcess } from '../src/application/profile-check/index.js';
import {
  PublicationProbe,
  PublicationProbeError,
  ReadinessError,
  ReadinessFiles,
  ReadinessGit,
  ReadinessHost,
  branchProtectionEvidenceFromProbeResult,
  checkReadiness,
  describePublicationReadiness,
  resolveBranchProtectionEvidence,
} from '../src/application/readiness/index.js';
import {
  GIT_OPERATION_MARKERS,
  displayPlatform,
  extractGitVersionNumber,
  isSupportedGitVersion,
  isSupportedPlatform,
  normalizeToolVersion,
  parseGitHubRepositoryRemote,
  parseGitVersion,
  publicationRepositoryScope,
} from '../src/domain/readiness.js';
import { BRANCH_PROTECTION_NOT_CONFIGURED } from '../src/domain/run-locations.js';
import { EXIT_CODES } from '../src/domain/public-commands.js';
import { ReadinessFilesLive, ReadinessGitLive } from '../src/platform/readiness.js';
import {
  capableRoleHostLauncher,
  incapableRoleHostLauncher,
} from './fixtures/role-host/role-host-launcher.js';

import type {
  PublicationProbeObservation,
  PublicationProbeRequest,
} from '../src/application/readiness/index.js';
import type { RoleHostLauncher } from '../src/application/role-conversations/index.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

function envelopeFrom(stdout: string) {
  return Schema.decodeUnknownSync(ReportEnvelopeJson)(stdout);
}

function expectDoctorEnvelope(stdout: string) {
  const envelope = envelopeFrom(stdout);
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) {
    throw new Error(`Expected a success envelope but received: ${stdout}`);
  }
  const data = envelope.data;
  if (!('readiness' in data)) {
    throw new Error(`Expected a doctor envelope but received: ${stdout}`);
  }
  return { envelope, data };
}

function expectDoctorFailure(stdout: string) {
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

function goldenDocument(targetRepository: string) {
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
  };
}

function publicationDocument(targetRepository: string) {
  return {
    ...goldenDocument(targetRepository),
    decisionPublication: { remote: 'origin', draft: true, maintainersCanModify: false },
  };
}

function eligibleObservation(
  overrides: Partial<PublicationProbeObservation> = {},
): PublicationProbeObservation {
  return {
    repository: 'foundry/target',
    tokenPresent: true,
    push: true,
    collaboratorPermission: 'maintain',
    issueCommentReadable: true,
    tokenScopes: null,
    protectedBranches: [],
    limitations: [],
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
      provided: true,
      observation: eligibleObservation(),
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
    files: {
      ...world.files,
      texts: new Map([[CONFIG_PATH, JSON.stringify(publicationDocument(TARGET))]]),
    },
    git: { ...world.git, ...git },
    publication: { ...world.publication, ...publication },
  };
}

function withTexts(world: FakeWorld, texts: ReadonlyMap<string, string>): FakeWorld {
  return { ...world, files: { ...world.files, texts } };
}

function withMarkers(world: FakeWorld, markers: ReadonlySet<string>): FakeWorld {
  return { ...world, files: { ...world.files, markers } };
}

const UnusedProcess = Layer.succeed(
  ProjectCommandProcess,
  ProjectCommandProcess.of({
    run: () => Effect.die(new Error('doctor must not run project commands')),
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

function checkWith(world: FakeWorld) {
  const built = buildWorld(world);
  return {
    built,
    check: checkReadiness({ configArg: CONFIG_ARG, cwd: CONFIG_DIR }).pipe(
      Effect.provide(built.layer),
    ),
  };
}

function expectNoBranchMutation(gitCalls: BuiltWorld['gitCalls']) {
  const verbs = gitCalls.map((call) => call.args[0]);
  for (const forbidden of ['checkout', 'switch', 'pull', 'fetch', 'merge', 'commit']) {
    expect(verbs).not.toContain(forbidden);
  }
}

describe('readiness domain vocabulary', () => {
  it('supports linux and windows host names', () => {
    expect(isSupportedPlatform('linux')).toBe(true);
    expect(isSupportedPlatform('win32')).toBe(true);
    expect(isSupportedPlatform('darwin')).toBe(false);
    expect(displayPlatform('win32')).toBe('windows');
    expect(displayPlatform('linux')).toBe('linux');
  });

  it('normalizes version output with a leading v', () => {
    expect(normalizeToolVersion('v24.14.0\n')).toBe('24.14.0');
    expect(normalizeToolVersion('11.9.0')).toBe('11.9.0');
  });

  it('parses git versions and enforces the 2.43 minimum', () => {
    expect(parseGitVersion('git version 2.43.0')).toEqual({ major: 2, minor: 43 });
    expect(parseGitVersion('git version 2.53.0.windows.1')).toEqual({ major: 2, minor: 53 });
    expect(parseGitVersion('not git output')).toBeUndefined();
    expect(isSupportedGitVersion({ major: 2, minor: 42 })).toBe(false);
    expect(isSupportedGitVersion({ major: 2, minor: 43 })).toBe(true);
    expect(isSupportedGitVersion({ major: 3, minor: 0 })).toBe(true);
    expect(extractGitVersionNumber('git version 2.53.0\n')).toBe('2.53.0');
    expect(extractGitVersionNumber('unexpected')).toBeUndefined();
  });

  it('recognizes GitHub repository remotes in common forms', () => {
    expect(parseGitHubRepositoryRemote('git@github.com:foundry/target.git')).toEqual({
      owner: 'foundry',
      name: 'target',
    });
    expect(parseGitHubRepositoryRemote('https://github.com/foundry/target.git\n')).toEqual({
      owner: 'foundry',
      name: 'target',
    });
    expect(parseGitHubRepositoryRemote('ssh://git@github.com/foundry/target')).toEqual({
      owner: 'foundry',
      name: 'target',
    });
    expect(parseGitHubRepositoryRemote('https://gitlab.com/foundry/target.git')).toBeUndefined();
    expect(parseGitHubRepositoryRemote('/srv/git/target.git')).toBeUndefined();
    expect(parseGitHubRepositoryRemote('')).toBeUndefined();
  });

  it('classifies repository scope from advertised token scopes', () => {
    expect(publicationRepositoryScope(null)).toBe('repository');
    expect(publicationRepositoryScope([])).toBe('repository');
    expect(publicationRepositoryScope(['read:user'])).toBe('repository');
    expect(publicationRepositoryScope(['repo'])).toBe('broad');
    expect(publicationRepositoryScope(['read:user', 'workflow'])).toBe('broad');
  });
});

describe('readiness check with fake services', () => {
  it.effect('reports host, configuration, storage, and repository identity when ready', () =>
    Effect.gen(function* () {
      const { built, check } = checkWith(defaultWorld());
      const report = yield* check;

      expect(report.host).toEqual({
        platform: 'linux',
        nodeVersion: '24.14.0',
        npmVersion: '11.9.0',
        gitVersion: '2.53.0',
      });
      expect(report.config).toEqual({ path: CONFIG_PATH, schemaVersion: 1 });
      expect(report.storage).toEqual({ path: '/target/.agent', ignored: true });
      expect(report.repository).toEqual({
        path: TARGET,
        remote: 'origin',
        branch: 'main',
        commit: COMMIT,
      });
      expectNoBranchMutation(built.gitCalls);
    }),
  );

  it.effect('reports windows for the win32 platform', () =>
    Effect.gen(function* () {
      const world = defaultWorld();
      const { check } = checkWith({
        ...world,
        host: { ...world.host, platform: 'win32' },
      });
      const report = yield* check;
      expect(report.host.platform).toBe('windows');
    }),
  );

  it.effect('fails on an unsupported operating system', () =>
    Effect.gen(function* () {
      const world = defaultWorld();
      const { check } = checkWith({
        ...world,
        host: { ...world.host, platform: 'darwin' },
      });
      const error = yield* check.pipe(Effect.flip);
      expect(error).toBeInstanceOf(ReadinessError);
      expect(error.message).toContain('Unsupported operating system: darwin');
    }),
  );

  it.effect('fails when a required tool is missing or mismatched', () =>
    Effect.gen(function* () {
      const missingCases = [
        { tool: 'node', fragment: 'Missing required tool: Node.js' },
        { tool: 'npm', fragment: 'Missing required tool: npm' },
        { tool: 'git', fragment: 'Missing required tool: Git' },
      ];
      for (const testCase of missingCases) {
        const world = defaultWorld();
        const { check } = checkWith({
          ...world,
          host: { ...world.host, missingTool: testCase.tool },
        });
        const error = yield* check.pipe(Effect.flip);
        expect(error.message, testCase.tool).toContain(testCase.fragment);
      }

      const mismatchedCases = [
        {
          label: 'node mismatch',
          host: { ...defaultWorld().host, nodeVersion: 'v24.13.0' },
          fragment: 'Unsupported Node.js version: 24.13.0. Expected 24.14.0.',
        },
        {
          label: 'npm mismatch',
          host: { ...defaultWorld().host, npmVersion: '11.8.0' },
          fragment: 'Unsupported npm version: 11.8.0. Expected 11.9.0.',
        },
        {
          label: 'old git',
          host: { ...defaultWorld().host, gitVersionOutput: 'git version 2.42.0\n' },
          fragment: 'Unsupported Git version: 2.42. Expected Git 2.43 or newer.',
        },
        {
          label: 'unparsable git',
          host: { ...defaultWorld().host, gitVersionOutput: 'git nope\n' },
          fragment: 'Unable to determine Git version',
        },
      ];
      for (const testCase of mismatchedCases) {
        const { check } = checkWith({ ...defaultWorld(), host: testCase.host });
        const error = yield* check.pipe(Effect.flip);
        expect(error.message, testCase.label).toContain(testCase.fragment);
      }
    }),
  );

  it.effect('fails when the configuration document cannot be used', () =>
    Effect.gen(function* () {
      const missing = checkWith(withTexts(defaultWorld(), new Map()));
      const missingError = yield* missing.check.pipe(Effect.flip);
      expect(missingError.message).toContain(
        `Cannot read configuration document at ${CONFIG_PATH}`,
      );

      const invalidJson = checkWith(withTexts(defaultWorld(), new Map([[CONFIG_PATH, '{oops']])));
      const jsonError = yield* invalidJson.check.pipe(Effect.flip);
      expect(jsonError.message).toContain('is not valid JSON');

      const unknownField = checkWith(
        withTexts(
          defaultWorld(),
          new Map([[CONFIG_PATH, JSON.stringify({ ...goldenDocument(TARGET), manual: true })]]),
        ),
      );
      const schemaError = yield* unknownField.check.pipe(Effect.flip);
      expect(schemaError.message).toContain('Expected schemaVersion 1');
    }),
  );

  it.effect('fails on tracked changes and untracked files outside ignored paths', () =>
    Effect.gen(function* () {
      const world = defaultWorld();
      for (const status of ['M  src/index.ts\n', '?? scratch-notes.txt\n']) {
        const { built, check } = checkWith({
          ...world,
          git: { ...world.git, statusStdout: status },
        });
        const error = yield* check.pipe(Effect.flip);
        expect(error.message, status).toContain(`is not clean`);
        expectNoBranchMutation(built.gitCalls);
      }
    }),
  );

  it.effect('fails when a redaction pattern is not a valid ECMAScript regular expression', () =>
    Effect.gen(function* () {
      const golden = goldenDocument(TARGET);
      const { check } = checkWith(
        withTexts(
          defaultWorld(),
          new Map([
            [
              CONFIG_PATH,
              JSON.stringify({
                ...golden,
                artifacts: { ...golden.artifacts, redactionPatterns: ['(unclosed'] },
              }),
            ],
          ]),
        ),
      );
      const error = yield* check.pipe(Effect.flip);
      expect(error).toBeInstanceOf(ReadinessError);
      expect(error.message).toContain('Redaction pattern "(unclosed"');
      expect(error.message).toContain('not a valid ECMAScript regular expression');
    }),
  );

  it.effect('names the git operation in progress', () =>
    Effect.gen(function* () {
      const seen = new Set<string>();
      for (const marker of GIT_OPERATION_MARKERS) {
        if (seen.has(marker.operation)) {
          continue;
        }
        seen.add(marker.operation);
        const world = defaultWorld();
        const { built, check } = checkWith(
          withMarkers(world, new Set([`/target/.git/${marker.marker}`])),
        );
        const error = yield* check.pipe(Effect.flip);
        expect(error.message, marker.operation).toContain(`Git ${marker.operation} in progress`);
        expectNoBranchMutation(built.gitCalls);
      }
      expect([...seen].sort()).toEqual(['bisect', 'cherry-pick', 'merge', 'rebase', 'revert']);
    }),
  );

  it.effect('fails when the source remote or branch is not reachable', () =>
    Effect.gen(function* () {
      const world = defaultWorld();

      const missingRemote = checkWith({
        ...world,
        git: { ...world.git, remotes: ['upstream'] },
      });
      const remoteError = yield* missingRemote.check.pipe(Effect.flip);
      expect(remoteError.message).toContain('Source remote "origin" is not configured');
      expectNoBranchMutation(missingRemote.built.gitCalls);

      const missingBranch = checkWith({
        ...world,
        git: { ...world.git, lsRemoteStdout: '' },
      });
      const branchError = yield* missingBranch.check.pipe(Effect.flip);
      expect(branchError.message).toContain('Source branch "main" is not reachable');

      const unreachable = checkWith({
        ...world,
        git: { ...world.git, lsRemoteStdout: '', lsRemoteExit: 128 },
      });
      const unreachableError = yield* unreachable.check.pipe(Effect.flip);
      expect(unreachableError.message).toContain('Source branch "main" is not reachable');
    }),
  );

  it.effect('fails when the target path is not a git work tree', () =>
    Effect.gen(function* () {
      const world = defaultWorld();
      const { check } = checkWith({
        ...world,
        git: { ...world.git, insideWorkTree: false },
      });
      const error = yield* check.pipe(Effect.flip);
      expect(error.message).toContain('is not a Git work tree');
    }),
  );

  it.effect('fails when run storage is not ignored, is tracked, or is unusable', () =>
    Effect.gen(function* () {
      const world = defaultWorld();

      const notIgnored = checkWith({
        ...world,
        git: { ...world.git, checkIgnoreExit: 1 },
      });
      const ignoreError = yield* notIgnored.check.pipe(Effect.flip);
      expect(ignoreError.message).toContain('is not ignored by Git');

      const tracked = checkWith({
        ...world,
        git: { ...world.git, trackedStdout: '.agent/runs/old/events.jsonl\n' },
      });
      const trackedError = yield* tracked.check.pipe(Effect.flip);
      expect(trackedError.message).toContain('is tracked by Git');

      const storageFile = checkWith(
        withTexts(
          world,
          new Map([
            [CONFIG_PATH, JSON.stringify(goldenDocument(TARGET))],
            ['/target/.agent', 'stale file where a directory belongs'],
          ]),
        ),
      );
      const fileError = yield* storageFile.check.pipe(Effect.flip);
      expect(fileError.message).toContain('is not a usable directory');

      const missingParent = checkWith({
        ...world,
        files: {
          ...world.files,
          directories: new Set([CONFIG_DIR]),
          writable: new Set(),
        },
      });
      const parentError = yield* missingParent.check.pipe(Effect.flip);
      expect(parentError.message).toContain('is not a usable directory location');
    }),
  );

  it.effect('serves doctor through the cli envelope without creating a live run', () =>
    Effect.gen(function* () {
      const built = buildWorld(defaultWorld());
      const result = yield* runCli(['doctor', '--config', CONFIG_PATH, '--json']).pipe(
        Effect.provide(built.layer),
      );

      expect(result.exitCode).toBe(EXIT_CODES.reported);
      const { envelope, data } = expectDoctorEnvelope(result.stdout);
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.command).toBe('doctor');
      expect(data.readiness).toBe('ready');
      expect(data.host.platform).toBe('linux');
      expect(data.config.path).toBe(CONFIG_PATH);
      expect(data.storage.path).toBe('/target/.agent');
      expect(data.repository.commit).toBe(COMMIT);
      expect(data.roleHost.protocol).toBe('foundry-role-host-v1');
      expect(data.roleHost.resumable).toBe(true);
      expect(data.roleHost.availableRoles).toEqual([
        'architect',
        'coder',
        'lead_coder',
        'tester',
        'reviewer',
      ]);
      expect(data.roleHost.networkProfiles).toEqual(['network_denied', 'runtime_origin_only']);
      expect(data.publication).toEqual({
        configured: false,
        eligible: false,
        remote: null,
        repository: null,
        repositoryScope: 'unknown',
        reason: null,
        capabilities: [],
      });
      expect(Object.keys(data)).toEqual([
        'readiness',
        'host',
        'config',
        'storage',
        'repository',
        'roleHost',
        'publication',
      ]);
      expectNoBranchMutation(built.gitCalls);
    }),
  );

  it.effect('presents the same doctor facts in human output as in json output', () =>
    Effect.gen(function* () {
      const built = buildWorld(defaultWorld());
      const runDoctor = (argv: ReadonlyArray<string>) =>
        runCli(argv).pipe(Effect.provide(built.layer));
      const jsonResult = yield* runDoctor(['doctor', '--config', CONFIG_PATH, '--json']);
      const humanResult = yield* runDoctor(['doctor', '--config', CONFIG_PATH]);
      expect(jsonResult.exitCode).toBe(EXIT_CODES.reported);
      expect(humanResult.exitCode).toBe(EXIT_CODES.reported);

      const { data } = expectDoctorEnvelope(jsonResult.stdout);
      expect(humanResult.stdout).toContain('data.readiness: ready');
      expect(humanResult.stdout).toContain(`data.host.platform: ${data.host.platform}`);
      expect(humanResult.stdout).toContain(`data.host.nodeVersion: ${data.host.nodeVersion}`);
      expect(humanResult.stdout).toContain(`data.host.npmVersion: ${data.host.npmVersion}`);
      expect(humanResult.stdout).toContain(`data.host.gitVersion: ${data.host.gitVersion}`);
      expect(humanResult.stdout).toContain(`data.config.path: ${data.config.path}`);
      expect(humanResult.stdout).toContain(`data.storage.path: ${data.storage.path}`);
      expect(humanResult.stdout).toContain(`data.repository.commit: ${data.repository.commit}`);
      expect(humanResult.stdout).toContain(`data.roleHost.protocol: ${data.roleHost.protocol}`);
      expect(humanResult.stdout).toContain(`data.roleHost.resumable: ${data.roleHost.resumable}`);
      expect(humanResult.stdout).toContain(
        `data.roleHost.availableRoles: ${data.roleHost.availableRoles.join(' ')}`,
      );
      expect(humanResult.stdout.endsWith('\n')).toBe(true);
    }),
  );

  it.effect('maps doctor failures to a failed report rather than an argument error', () =>
    Effect.gen(function* () {
      const world = defaultWorld();
      const built = buildWorld({
        ...world,
        git: { ...world.git, statusStdout: '?? scratch.txt\n' },
      });
      const result = yield* runCli(['doctor', '--config', CONFIG_PATH, '--json']).pipe(
        Effect.provide(built.layer),
      );

      expect(result.exitCode).toBe(EXIT_CODES.operationFailed);
      const envelope = expectDoctorFailure(result.stdout);
      expect(envelope.command).toBe('doctor');
      expect(envelope.error.kind).toBe('failed');
      expect(envelope.error.retryable).toBe(false);
      expect(envelope.error.message).toContain('is not clean');
    }),
  );

  it.effect('fails clearly when the role host cannot attest sessions or required profiles', () =>
    Effect.gen(function* () {
      const incapableCases = [
        {
          label: 'non-resumable',
          launcher: incapableRoleHostLauncher({ resumable: false }),
          reason: 'not-resumable',
          fragment: 'resumable',
        },
        {
          label: 'unsupported protocol',
          launcher: incapableRoleHostLauncher({ protocol: 'foundry-role-host-v0' }),
          reason: 'unsupported-protocol',
          fragment: 'foundry-role-host-v0',
        },
        {
          label: 'missing role',
          launcher: incapableRoleHostLauncher({
            availableRoles: ['architect', 'coder', 'lead_coder', 'reviewer'],
          }),
          reason: 'missing-role',
          fragment: '"tester"',
        },
        {
          label: 'missing network profile',
          launcher: incapableRoleHostLauncher({
            capabilityProfiles: {
              filesystem: [
                'read_only_snapshot',
                'run_owned_worktree',
                'owned_scratch',
                'owned_capture_scratch',
              ],
              network: ['network_denied'],
            },
          }),
          reason: 'missing-profile',
          fragment: 'runtime_origin_only',
        },
      ];

      for (const testCase of incapableCases) {
        const built = buildWorld(defaultWorld(), testCase.launcher);
        const error = yield* checkReadiness({ configArg: CONFIG_ARG, cwd: CONFIG_DIR }).pipe(
          Effect.provide(built.layer),
          Effect.flip,
        );
        expect(error, testCase.label).toBeInstanceOf(RoleHostCapabilityError);
        if (!(error instanceof RoleHostCapabilityError)) {
          throw new Error(`Expected a RoleHostCapabilityError for ${testCase.label}.`);
        }
        expect(error.reason, testCase.label).toBe(testCase.reason);
        expect(error.message, testCase.label).toContain(testCase.fragment);
      }
    }),
  );

  it.effect('maps an incapable role host to a failed report rather than an argument error', () =>
    Effect.gen(function* () {
      const built = buildWorld(defaultWorld(), incapableRoleHostLauncher({ resumable: false }));
      const result = yield* runCli(['doctor', '--config', CONFIG_PATH, '--json']).pipe(
        Effect.provide(built.layer),
      );

      expect(result.exitCode).toBe(EXIT_CODES.operationFailed);
      const envelope = expectDoctorFailure(result.stdout);
      expect(envelope.command).toBe('doctor');
      expect(envelope.error.kind).toBe('failed');
      expect(envelope.error.retryable).toBe(false);
      expect(envelope.error.message).toContain('resumable');
    }),
  );
});

describe('publication readiness with fake services', () => {
  it.effect('reports publication as not configured without probing GitHub', () =>
    Effect.gen(function* () {
      const { built, check } = checkWith(defaultWorld());
      const report = yield* check;

      expect(report.publication).toEqual({
        configured: false,
        eligible: false,
        remote: null,
        repository: null,
        repositoryScope: 'unknown',
        reason: null,
        capabilities: [],
      });
      expect(built.gitCalls.some((call) => call.args[1] === 'get-url')).toBe(false);
    }),
  );

  it.effect('reports eligible publication when identity and capabilities verify', () =>
    Effect.gen(function* () {
      const { check } = checkWith(publicationWorld());
      const report = yield* check;

      expect(report.publication).toEqual({
        configured: true,
        eligible: true,
        remote: 'origin',
        repository: 'foundry/target',
        repositoryScope: 'repository',
        reason: null,
        capabilities: [
          { capability: 'push', state: 'granted' },
          { capability: 'pull_request', state: 'granted' },
          { capability: 'issue_comment_read', state: 'granted' },
          { capability: 'collaborator_permission', state: 'granted' },
        ],
      });
    }),
  );

  it.effect('presents eligible publication with a null reason through the cli envelope', () =>
    Effect.gen(function* () {
      const { built } = checkWith(publicationWorld());
      const jsonResult = yield* runCli(['doctor', '--config', CONFIG_PATH, '--json']).pipe(
        Effect.provide(built.layer),
      );
      const humanResult = yield* runCli(['doctor', '--config', CONFIG_PATH]).pipe(
        Effect.provide(built.layer),
      );

      expect(jsonResult.exitCode).toBe(EXIT_CODES.reported);
      expect(humanResult.exitCode).toBe(EXIT_CODES.reported);
      const { data } = expectDoctorEnvelope(jsonResult.stdout);
      expect(data.publication).toEqual({
        configured: true,
        eligible: true,
        remote: 'origin',
        repository: 'foundry/target',
        repositoryScope: 'repository',
        reason: null,
        capabilities: [
          { capability: 'push', state: 'granted' },
          { capability: 'pull_request', state: 'granted' },
          { capability: 'issue_comment_read', state: 'granted' },
          { capability: 'collaborator_permission', state: 'granted' },
        ],
      });
      expect(humanResult.stdout).toContain('data.publication.configured: true');
      expect(humanResult.stdout).toContain('data.publication.eligible: true');
      expect(humanResult.stdout).toContain('data.publication.remote: origin');
      expect(humanResult.stdout).toContain('data.publication.repository: foundry/target');
      expect(humanResult.stdout).toContain('data.publication.repositoryScope: repository');
      expect(humanResult.stdout).toContain('data.publication.reason: none');
      expect(humanResult.stdout).toContain(
        'data.publication.capabilities: push=granted pull_request=granted issue_comment_read=granted collaborator_permission=granted',
      );
    }),
  );

  it.effect('reports a specific reason when the publication remote is not GitHub', () =>
    Effect.gen(function* () {
      const { check } = checkWith(
        publicationWorld({}, { remoteUrlStdout: 'https://gitlab.com/foundry/target.git\n' }),
      );
      const report = yield* check;

      expect(report.publication.eligible).toBe(false);
      expect(report.publication.repository).toBeNull();
      expect(report.publication.reason).toContain('is not a GitHub repository');
    }),
  );

  it.effect('reports a specific reason when the publication remote cannot be resolved', () =>
    Effect.gen(function* () {
      const { check } = checkWith(
        publicationWorld({}, { remoteUrlStdout: '', remoteUrlExit: 128 }),
      );
      const report = yield* check;

      expect(report.publication.eligible).toBe(false);
      expect(report.publication.reason).toContain('Cannot resolve publication remote "origin"');
    }),
  );

  it.effect('reports missing credentials without asserting unverified capability absence', () =>
    Effect.gen(function* () {
      const { check } = checkWith(
        publicationWorld({
          observation: eligibleObservation({
            repository: 'foundry/target',
            tokenPresent: false,
            push: false,
            collaboratorPermission: null,
            issueCommentReadable: null,
            tokenScopes: null,
          }),
        }),
      );
      const report = yield* check;

      expect(report.publication.eligible).toBe(false);
      expect(report.publication.reason).toContain('GITHUB_TOKEN is not set');
      expect(report.publication.capabilities.map((entry) => entry.state)).toEqual([
        'unknown',
        'unknown',
        'unknown',
        'unknown',
      ]);
    }),
  );

  it.effect('reports denied capabilities with a concrete reason', () =>
    Effect.gen(function* () {
      const { check } = checkWith(
        publicationWorld({ observation: eligibleObservation({ push: false }) }),
      );
      const report = yield* check;

      expect(report.publication.eligible).toBe(false);
      expect(report.publication.reason).toContain('push');
      expect(report.publication.reason).toContain('pull_request');
      expect(report.publication.capabilities).toContainEqual({
        capability: 'push',
        state: 'denied',
      });
    }),
  );

  it.effect('reports ineligible when the credential is not limited to the repository', () =>
    Effect.gen(function* () {
      const { check } = checkWith(
        publicationWorld({
          observation: eligibleObservation({ tokenScopes: ['repo', 'workflow'] }),
        }),
      );
      const report = yield* check;

      expect(report.publication.eligible).toBe(false);
      expect(report.publication.repositoryScope).toBe('broad');
      expect(report.publication.reason).toContain(
        'not limited to the configured publication repository',
      );
    }),
  );

  it.effect('reports ineligible when the credential resolves to another repository', () =>
    Effect.gen(function* () {
      const { check } = checkWith(
        publicationWorld({ observation: eligibleObservation({ repository: 'other/repo' }) }),
      );
      const report = yield* check;

      expect(report.publication.eligible).toBe(false);
      expect(report.publication.reason).toContain('other/repo');
      expect(report.publication.reason).toContain('foundry/target');
    }),
  );

  it.effect('reports ineligible rather than failing when the GitHub probe is unavailable', () =>
    Effect.gen(function* () {
      const { check } = checkWith(publicationWorld({ error: 'GitHub API is unreachable.' }));
      const report = yield* check;

      expect(report.publication.eligible).toBe(false);
      expect(report.publication.reason).toContain('GitHub API is unreachable');
      expect(report.publication.capabilities.map((entry) => entry.state)).toEqual([
        'unknown',
        'unknown',
        'unknown',
        'unknown',
      ]);
    }),
  );

  it.effect('reports ineligible when no publication probe is provided', () =>
    Effect.gen(function* () {
      const { check } = checkWith(publicationWorld({ provided: false }));
      const report = yield* check;

      expect(report.publication.eligible).toBe(false);
      expect(report.publication.repository).toBe('foundry/target');
      expect(report.publication.reason).toContain('probe is unavailable');
    }),
  );
});

describe('publication branch protection evidence', () => {
  it('maps publication configuration and probe observations to branch protection evidence', () => {
    expect(
      branchProtectionEvidenceFromProbeResult({
        publicationConfigured: false,
        observation: null,
        probeUnavailableReason: null,
      }),
    ).toEqual(BRANCH_PROTECTION_NOT_CONFIGURED);

    expect(
      branchProtectionEvidenceFromProbeResult({
        publicationConfigured: true,
        observation: eligibleObservation({ protectedBranches: ['main', 'release'] }),
        probeUnavailableReason: null,
      }),
    ).toEqual({ _tag: 'Known', protectedBranches: ['main', 'release'] });

    expect(
      branchProtectionEvidenceFromProbeResult({
        publicationConfigured: true,
        observation: eligibleObservation({ protectedBranches: null }),
        probeUnavailableReason: null,
      })._tag,
    ).toBe('Uncertain');

    expect(
      branchProtectionEvidenceFromProbeResult({
        publicationConfigured: true,
        observation: null,
        probeUnavailableReason: 'GitHub API is unreachable.',
      }),
    ).toEqual({
      _tag: 'Uncertain',
      reason: 'GitHub API is unreachable.',
    });
  });

  it.effect(
    'resolves known protected branches from the publication probe without an override',
    () =>
      Effect.gen(function* () {
        const { built } = checkWith(
          publicationWorld({
            observation: eligibleObservation({ protectedBranches: ['main', 'release'] }),
          }),
        );
        const evidence = yield* resolveBranchProtectionEvidence(
          { remote: 'origin', draft: true, maintainersCanModify: false },
          TARGET,
        ).pipe(Effect.provide(built.layer));

        expect(evidence).toEqual({ _tag: 'Known', protectedBranches: ['main', 'release'] });
      }),
  );

  it.effect('fails closed when the probe cannot establish protected branch names', () =>
    Effect.gen(function* () {
      const { built } = checkWith(
        publicationWorld({
          observation: eligibleObservation({ protectedBranches: null }),
        }),
      );
      const evidence = yield* resolveBranchProtectionEvidence(
        { remote: 'origin', draft: true, maintainersCanModify: false },
        TARGET,
      ).pipe(Effect.provide(built.layer));

      expect(evidence._tag).toBe('Uncertain');
    }),
  );

  it.effect('treats configured but doctor-ineligible publication as not publication-eligible', () =>
    Effect.gen(function* () {
      const { built } = checkWith(
        publicationWorld({
          observation: eligibleObservation({ tokenPresent: false, protectedBranches: null }),
        }),
      );
      const report = yield* describePublicationReadiness(
        { remote: 'origin', draft: true, maintainersCanModify: false },
        TARGET,
      ).pipe(Effect.provide(built.layer));

      expect(report.configured).toBe(true);
      expect(report.eligible).toBe(false);
    }),
  );
});

function setupRealRepository(label: string) {
  const remote = mkdtempSync(join(tmpdir(), `foundry-doctor-${label}-remote-`));
  const dir = mkdtempSync(join(tmpdir(), `foundry-doctor-${label}-`));
  const scratch = mkdtempSync(join(tmpdir(), `foundry-doctor-${label}-config-`));
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'doctor@example.com'], {
    encoding: 'utf8',
  });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Foundry Doctor'], { encoding: 'utf8' });
  writeFileSync(join(dir, 'README.md'), '# target\n');
  writeFileSync(join(dir, '.gitignore'), '.agent\n');
  execFileSync('git', ['-C', dir, 'add', 'README.md', '.gitignore'], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial'], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote], { encoding: 'utf8' });
  execFileSync('git', ['-C', dir, 'push', '-u', 'origin', 'main'], { encoding: 'utf8' });
  return { dir, remote, scratch };
}

function writeRealConfig(home: string, target: string, sourceBranch: string) {
  const configPath = join(home, 'foundry.config.json');
  writeFileSync(configPath, JSON.stringify({ ...goldenDocument(target), sourceBranch }));
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

describe('doctor against real temporary git repositories', () => {
  it.effect('succeeds on a clean repository without touching the checkout or creating runs', () =>
    Effect.gen(function* () {
      const { dir, remote, scratch } = yield* Effect.sync(() => setupRealRepository('clean'));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          mkdirSync(join(dir, '.agent'), { recursive: true });
          const configPath = writeRealConfig(join(dir, '.agent'), dir, 'main');
          const beforeHead = realGit(dir, ['rev-parse', 'HEAD']).trim();
          const beforeBranch = realGit(dir, ['branch', '--show-current']).trim();
          const beforeStatus = realGit(dir, ['status', '--porcelain']);

          const report = yield* checkReadiness({ configArg: configPath, cwd: dir }).pipe(
            Effect.provide(integrationLayer),
          );

          expect(report.repository.path).toBe(dir);
          expect(report.repository.remote).toBe('origin');
          expect(report.repository.branch).toBe('main');
          expect(report.repository.commit).toBe(beforeHead);
          expect(realGit(dir, ['rev-parse', 'HEAD']).trim()).toBe(beforeHead);
          expect(realGit(dir, ['branch', '--show-current']).trim()).toBe(beforeBranch);
          expect(realGit(dir, ['status', '--porcelain'])).toBe(beforeStatus);
          expect(existsSync(join(dir, '.agent', 'runs'))).toBe(false);
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
          const configPath = writeRealConfig(join(dir, '.agent'), dir, 'main');

          const error = yield* checkReadiness({ configArg: configPath, cwd: dir }).pipe(
            Effect.provide(integrationLayer),
            Effect.flip,
          );

          expect(error.message).toContain('is not clean');
          expect(realGit(dir, ['branch', '--show-current']).trim()).toBe(beforeBranch);
        }),
        cleanupRealRepository([dir, remote, scratch]),
      );
    }),
  );

  it.effect('fails when a merge marker exists', () =>
    Effect.gen(function* () {
      const { dir, remote, scratch } = yield* Effect.sync(() => setupRealRepository('merge'));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const head = realGit(dir, ['rev-parse', 'HEAD']).trim();
          writeFileSync(join(dir, '.git', 'MERGE_HEAD'), `${head}\n`);
          mkdirSync(join(dir, '.agent'), { recursive: true });
          const configPath = writeRealConfig(join(dir, '.agent'), dir, 'main');

          const error = yield* checkReadiness({ configArg: configPath, cwd: dir }).pipe(
            Effect.provide(integrationLayer),
            Effect.flip,
          );

          expect(error.message).toContain('Git merge in progress');
          expect(realGit(dir, ['branch', '--show-current']).trim()).toBe('main');
        }),
        cleanupRealRepository([dir, remote, scratch]),
      );
    }),
  );

  it.effect('fails when the source branch is missing on the remote', () =>
    Effect.gen(function* () {
      const { dir, remote, scratch } = yield* Effect.sync(() => setupRealRepository('branch'));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          mkdirSync(join(dir, '.agent'), { recursive: true });
          const configPath = writeRealConfig(join(dir, '.agent'), dir, 'missing-branch');

          const error = yield* checkReadiness({ configArg: configPath, cwd: dir }).pipe(
            Effect.provide(integrationLayer),
            Effect.flip,
          );

          expect(error.message).toContain('Source branch "missing-branch" is not reachable');
          expect(realGit(dir, ['branch', '--show-current']).trim()).toBe('main');
        }),
        cleanupRealRepository([dir, remote, scratch]),
      );
    }),
  );

  it.effect('fails when run storage is not ignored', () =>
    Effect.gen(function* () {
      const { dir, remote, scratch } = yield* Effect.sync(() => setupRealRepository('storage'));
      yield* Effect.ensuring(
        Effect.gen(function* () {
          writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
          execFileSync('git', ['-C', dir, 'add', '.gitignore'], { encoding: 'utf8' });
          execFileSync('git', ['-C', dir, 'commit', '-m', 'unignore agent'], {
            encoding: 'utf8',
          });
          const configPath = writeRealConfig(scratch, dir, 'main');

          const error = yield* checkReadiness({ configArg: configPath, cwd: dir }).pipe(
            Effect.provide(integrationLayer),
            Effect.flip,
          );

          expect(error.message).toContain('is not ignored by Git');
        }),
        cleanupRealRepository([dir, remote, scratch]),
      );
    }),
  );
});
