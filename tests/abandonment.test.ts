import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { abandonRun } from '../src/application/abandonment/index.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import {
  OwnedProjectProcess,
  ProjectCommandProcess,
  ProjectEvidenceStore,
} from '../src/application/project-commands/index.js';
import { decodeProjectConfiguration } from '../src/application/project-configuration.js';
import { ReadinessGit, ReadinessHost } from '../src/application/readiness/index.js';
import { RoleHostLauncher } from '../src/application/role-conversations/index.js';
import {
  appendRunEvent,
  RunHistoryStorage,
  RunHistoryStorageError,
} from '../src/application/run-history/index.js';
import {
  RunIdentityStore,
  RunIdentityStorageError,
} from '../src/application/run-identity/index.js';
import { IllegalWorkflowTransition } from '../src/application/workflow-transitions/index.js';
import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { EXIT_CODES } from '../src/domain/public-commands.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import { GuidanceLive } from '../src/platform/guidance.js';
import { RunGitLive } from '../src/platform/git-provisioning.js';
import { ProjectCommandsPlatformLive } from '../src/platform/project-commands.js';
import { ReadinessFilesLive, ReadinessGitLive } from '../src/platform/readiness.js';
import { RepositoryLeaseLive } from '../src/platform/repository-lease.js';
import { RoleTurnResourceObserverLive } from '../src/platform/role-permissions.js';
import { RunIdentityLive as RunIdentityPlatformLive } from '../src/platform/run-identity.js';
import { scriptedRoleHostLauncher } from './fixtures/role-host/role-host-launcher.js';
import { goldenConfigurationDocument } from './fixtures/checks-runtime-run.js';

import type { ProjectConfiguration } from '../src/domain/project-configuration.js';
import type { RunEventDraft } from '../src/domain/run-history.js';
import type { RunHistoryStorage as RunHistoryStorageService } from '../src/application/run-history/index.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

const RUN_ID = 'RUN-ABANDON';
const TASK_ID = 'TASK-ABANDON';
const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const TASK_BRANCH = 'foundry/TASK-ABANDON';

interface UnitFixture {
  readonly runDirectory: string;
  readonly workspace: string;
  readonly removed: Array<string>;
  failRemoval: boolean;
  readonly cleanup: () => void;
}

function setupUnitFixture(): UnitFixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-abandonment-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  const workspace = join(base, 'worktree');
  mkdirSync(workspace, { recursive: true });
  return {
    runDirectory,
    workspace,
    removed: [],
    failRemoval: false,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function fakeStore(fixture: UnitFixture): Layer.Layer<RunIdentityStore> {
  return Layer.succeed(
    RunIdentityStore,
    RunIdentityStore.of({
      statPath: () => Effect.succeed({ exists: false, isRegularFile: false }),
      readFileBytes: () => Effect.succeed(new Uint8Array()),
      ensureParentDirectory: () => Effect.void,
      createRunDirectoryExclusive: () => Effect.void,
      writeFileBytes: () => Effect.void,
      removeDirectory: (path: string) =>
        fixture.failRemoval
          ? Effect.fail(new RunIdentityStorageError({ message: 'removal refused', runId: RUN_ID }))
          : Effect.sync(() => {
              fixture.removed.push(path);
            }),
      listRuns: () => Effect.succeed([]),
      readDirectory: () => Effect.succeed([]),
    }),
  );
}

function unusedRuntimeLayers(): Layer.Layer<
  OwnedProjectProcess | ProjectCommandProcess | ProjectEvidenceStore | ReadinessGit | RunGit
> {
  return Layer.mergeAll(
    Layer.succeed(
      OwnedProjectProcess,
      OwnedProjectProcess.of({
        start: () => Effect.die(new Error('unused start')),
        terminate: () => Effect.die(new Error('unused terminate')),
      }),
    ),
    Layer.succeed(
      ProjectCommandProcess,
      ProjectCommandProcess.of({ run: () => Effect.die(new Error('unused run')) }),
    ),
    Layer.succeed(
      ProjectEvidenceStore,
      ProjectEvidenceStore.of({ write: () => Effect.die(new Error('unused write')) }),
    ),
    Layer.succeed(
      ReadinessGit,
      ReadinessGit.of({ run: () => Effect.die(new Error('unused git')) }),
    ),
    Layer.succeed(
      RunGit,
      RunGit.of({
        inspectRepository: () => Effect.die(new Error('unused inspectRepository')),
        fetchSource: () => Effect.die(new Error('unused fetchSource')),
        commitExists: () => Effect.die(new Error('unused commitExists')),
        readBranch: () => Effect.die(new Error('unused readBranch')),
        createBranch: () => Effect.die(new Error('unused createBranch')),
        readWorktree: () => Effect.die(new Error('unused readWorktree')),
        createWorktree: () => Effect.die(new Error('unused createWorktree')),
        observeImplementation: () => Effect.die(new Error('unused observeImplementation')),
      }),
    ),
  );
}

function unusedLauncher(): Layer.Layer<RoleHostLauncher> {
  return Layer.succeed(
    RoleHostLauncher,
    RoleHostLauncher.of({
      launch: () => {
        throw new Error('abandonment tests must not launch the role host');
      },
    }),
  );
}

function emit(runDirectory: string, createIfMissing: boolean, draft: RunEventDraft) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing,
    build: () => Effect.succeed(draft),
  });
}

function seedRun(runDirectory: string, workspace: string) {
  return Effect.gen(function* () {
    yield* emit(runDirectory, true, {
      type: 'run-created',
      payload: { taskId: TASK_ID },
    });
    yield* emit(runDirectory, false, {
      type: 'source-frozen',
      payload: {
        repository: {
          repositoryRoot: '/target',
          gitDirectory: '/target/.git',
          remoteUrl: 'https://example.invalid/target.git',
        },
        sourceRemote: 'origin',
        sourceBranch: 'main',
        sourceCommit: FROZEN_COMMIT,
        taskBranch: TASK_BRANCH,
        workspace,
        expectedHead: FROZEN_COMMIT,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'guidance-frozen',
      payload: {
        sourceCommit: FROZEN_COMMIT,
        manifestPath: 'guidance-manifest.json',
        aggregateHash: 'f'.repeat(64),
        files: [],
      },
    });
    yield* emit(runDirectory, false, {
      type: 'worktree-ready',
      payload: {
        taskBranch: TASK_BRANCH,
        workspace,
        headCommit: FROZEN_COMMIT,
        baseCommit: FROZEN_COMMIT,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function failRun(runDirectory: string) {
  return emit(runDirectory, false, {
    type: 'workflow-transition',
    payload: { route: 'fail-run', from: 'planning', to: 'failed', checkpoint: null },
  }).pipe(Effect.provide(RunHistoryLive));
}

function configurationFor(): ProjectConfiguration {
  return Effect.runSync(
    decodeProjectConfiguration(goldenConfigurationDocument('/target', false), '/target'),
  );
}

function runAbandon(
  fixture: UnitFixture,
  reason: string,
  storage?: Layer.Layer<RunHistoryStorageService>,
) {
  const history = storage ?? RunHistoryLive;
  return abandonRun({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    configuration: configurationFor(),
    reason,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(history, fakeStore(fixture), unusedLauncher(), unusedRuntimeLayers()),
    ),
  );
}

function readHistory(runDirectory: string) {
  return Effect.gen(function* () {
    const storage = yield* RunHistoryStorage;
    const snapshot = yield* storage.readHistoryFiles(runDirectory);
    return snapshot;
  }).pipe(Effect.provide(RunHistoryLive));
}

describe('abandonRun', () => {
  it.live('ends a nonterminal run as abandoned and disposes owned resources', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        yield* seedRun(fixture.runDirectory, fixture.workspace);
        const report = yield* runAbandon(fixture, 'superseded by a new request');
        expect(report).toMatchObject({
          runId: RUN_ID,
          workflowState: 'abandoned',
          reason: 'superseded by a new request',
        });
        expect(report.cleanup?.outcome).toBe('succeeded');
        expect(fixture.removed).toEqual([fixture.workspace]);

        const snapshot = yield* readHistory(fixture.runDirectory);
        expect(snapshot.stream.kind).toBe('file');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('is idempotent for the same reason and appends nothing new', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        yield* seedRun(fixture.runDirectory, fixture.workspace);
        yield* runAbandon(fixture, 'the same reason');
        const first = yield* readHistory(fixture.runDirectory);
        const second = yield* runAbandon(fixture, 'the same reason');
        const after = yield* readHistory(fixture.runDirectory);
        expect(second.reason).toBe('the same reason');
        expect(second.cleanup?.outcome).toBe('succeeded');
        expect(after.stream.kind === 'file' && first.stream.kind === 'file').toBe(true);
        if (after.stream.kind === 'file' && first.stream.kind === 'file') {
          expect(after.stream.bytes.byteLength).toBe(first.stream.bytes.byteLength);
        }
        expect(fixture.removed).toEqual([fixture.workspace]);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('notes a different later reason without rerunning disposal', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        yield* seedRun(fixture.runDirectory, fixture.workspace);
        yield* runAbandon(fixture, 'first reason');
        const report = yield* runAbandon(fixture, 'a different later reason');
        expect(report.reason).toBe('a different later reason');
        expect(report.cleanup?.outcome).toBe('succeeded');
        expect(fixture.removed).toEqual([fixture.workspace]);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('refuses a terminal non-abandoned run without changing history', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        yield* seedRun(fixture.runDirectory, fixture.workspace);
        yield* failRun(fixture.runDirectory);
        const before = yield* readHistory(fixture.runDirectory);
        const outcome = yield* runAbandon(fixture, 'should not apply').pipe(Effect.result);
        expect(outcome._tag).toBe('Failure');
        if (outcome._tag === 'Failure') {
          expect(outcome.failure).toBeInstanceOf(IllegalWorkflowTransition);
        }
        const after = yield* readHistory(fixture.runDirectory);
        if (before.stream.kind === 'file' && after.stream.kind === 'file') {
          expect(after.stream.bytes.byteLength).toBe(before.stream.bytes.byteLength);
        }
        expect(fixture.removed).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('refuses a run with no recorded workflow state', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        yield* emit(fixture.runDirectory, true, {
          type: 'run-created',
          payload: { taskId: TASK_ID },
        }).pipe(Effect.provide(RunHistoryLive));
        const outcome = yield* runAbandon(fixture, 'nothing to end').pipe(Effect.result);
        expect(outcome._tag).toBe('Failure');
        if (outcome._tag === 'Failure') {
          expect(outcome.failure).toBeInstanceOf(IllegalWorkflowTransition);
        }
        expect(fixture.removed).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('rejects an empty reason before any durable write', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        yield* seedRun(fixture.runDirectory, fixture.workspace);
        const before = yield* readHistory(fixture.runDirectory);
        const outcome = yield* runAbandon(fixture, '   ').pipe(Effect.result);
        expect(outcome._tag).toBe('Failure');
        if (outcome._tag === 'Failure') {
          expect(outcome.failure).toBeInstanceOf(IllegalWorkflowTransition);
        }
        const after = yield* readHistory(fixture.runDirectory);
        if (before.stream.kind === 'file' && after.stream.kind === 'file') {
          expect(after.stream.bytes.byteLength).toBe(before.stream.bytes.byteLength);
        }
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('keeps a disposal failure separate from the terminal abandoned state', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        fixture.failRemoval = true;
        yield* seedRun(fixture.runDirectory, fixture.workspace);
        const report = yield* runAbandon(fixture, 'cleanup will fail');
        expect(report.workflowState).toBe('abandoned');
        expect(report.cleanup?.outcome).toBe('failed');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('self-heals the initial note when its first write fails', () =>
    Effect.gen(function* () {
      const fixture = setupUnitFixture();
      try {
        yield* seedRun(fixture.runDirectory, fixture.workspace);
        const failNext = { value: true };
        const storage = failingNoteStorageLayer(failNext);
        const first = yield* runAbandon(fixture, 'retry my note', storage).pipe(Effect.result);
        expect(first._tag).toBe('Failure');

        const second = yield* runAbandon(fixture, 'retry my note', storage);
        expect(second.reason).toBe('retry my note');
        expect(second.cleanup?.outcome).toBe('succeeded');
        expect(fixture.removed).toEqual([fixture.workspace]);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

function failingNoteStorageLayer(state: { value: boolean }): Layer.Layer<RunHistoryStorageService> {
  const wrapper = Layer.effect(
    RunHistoryStorage,
    Effect.map(RunHistoryStorage, (live) =>
      RunHistoryStorage.of({
        readHistoryFiles: (runDirectory) => live.readHistoryFiles(runDirectory),
        commitHistory: (options) => {
          const text = new TextDecoder().decode(options.nextStreamBytes);
          if (state.value && text.includes('"type":"abandonment-note"')) {
            state.value = false;
            return Effect.fail(
              new RunHistoryStorageError({
                message: 'simulated note write failure',
                runId: RUN_ID,
              }),
            );
          }
          return live.commitHistory(options);
        },
        replaceDerivedReports: (options) => live.replaceDerivedReports(options),
      }),
    ),
  );
  return wrapper.pipe(Layer.provide(RunHistoryLive));
}

interface CliFixture {
  readonly base: string;
  readonly target: string;
  readonly configPath: string;
  readonly cleanup: () => void;
}

function setupCliFixture(): CliFixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-abandonment-cli-'));
  const target = join(base, 'target');
  mkdirSync(join(target, '.agent', 'runs', RUN_ID), { recursive: true });
  const configPath = join(base, 'foundry.config.json');
  writeFileSync(configPath, JSON.stringify(goldenConfigurationDocument(target, false)));
  return {
    base,
    target,
    configPath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function runDirectoryOf(fixture: CliFixture) {
  return join(fixture.target, '.agent', 'runs', RUN_ID);
}

const readinessHost = Layer.succeed(
  ReadinessHost,
  ReadinessHost.of({
    platform: Effect.succeed('linux'),
    nodeVersion: Effect.succeed('v24.0.0'),
    npmVersion: Effect.succeed('11.0.0'),
    gitVersionOutput: Effect.succeed('git version 2.45.0'),
  }),
);

const capabilityLayers = Layer.mergeAll(
  readinessHost,
  ReadinessFilesLive,
  ReadinessGitLive,
  ProjectCommandsPlatformLive,
  RunIdentityPlatformLive,
  RunHistoryLive,
  RepositoryLeaseLive,
  RoleTurnResourceObserverLive,
  RunGitLive,
  GuidanceLive,
  Layer.succeed(
    ProjectCommandProcess,
    ProjectCommandProcess.of({
      run: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
    }),
  ),
);

function runCliAbandon(fixture: CliFixture, reason: string) {
  return runCli([
    'resume',
    '--config',
    fixture.configPath,
    '--run-id',
    RUN_ID,
    '--abandon',
    '--reason',
    reason,
    '--json',
  ]).pipe(
    Effect.provide(Layer.mergeAll(capabilityLayers, scriptedRoleHostLauncher({}), RunIdentityLive)),
  );
}

describe('resume --abandon command', () => {
  it.live('rejects an empty reason with exit code 2', () =>
    Effect.gen(function* () {
      const fixture = setupCliFixture();
      try {
        const result = yield* runCliAbandon(fixture, '');
        expect(result.exitCode).toBe(EXIT_CODES.invalidInvocation);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('abandons a nonterminal run and reports the terminal state', () =>
    Effect.gen(function* () {
      const fixture = setupCliFixture();
      try {
        const runDirectory = runDirectoryOf(fixture);
        yield* seedRun(runDirectory, join(fixture.base, 'worktree')).pipe(
          Effect.provide(RunHistoryLive),
        );
        const result = yield* runCliAbandon(fixture, 'superseded');
        expect(result.exitCode).toBe(EXIT_CODES.reported);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(true);
        if (!envelope.ok || !('reason' in envelope.data)) {
          throw new Error(`Expected an abandon envelope: ${result.stdout}`);
        }
        expect(envelope.data.workflowState).toBe('abandoned');
        expect(envelope.data.reason).toBe('superseded');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('refuses a terminal non-abandoned run with exit code 1', () =>
    Effect.gen(function* () {
      const fixture = setupCliFixture();
      try {
        const runDirectory = runDirectoryOf(fixture);
        yield* seedRun(runDirectory, join(fixture.base, 'worktree')).pipe(
          Effect.provide(RunHistoryLive),
        );
        yield* failRun(runDirectory).pipe(Effect.provide(RunHistoryLive));
        const result = yield* runCliAbandon(fixture, 'too late');
        expect(result.exitCode).toBe(EXIT_CODES.operationFailed);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
