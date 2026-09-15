import { describe, expect, it } from '@effect/vitest';
import { Duration, Effect, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { ReadinessFilesLive } from '../src/platform/readiness.js';
import { RoleHostLauncher } from '../src/application/role-conversations/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import {
  RunIdentityStorageError,
  RunIdentityStore,
} from '../src/application/run-identity/index.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import { appendRunEvent } from '../src/application/run-history/index.js';
import {
  readRetentionCleanupList,
  runRetentionCleanup,
} from '../src/application/retention-cleanup/index.js';

import type { RunEventDraft } from '../src/domain/run-history.js';
import type { RunHistoryStorage } from '../src/application/run-history/index.js';
import type { ReadinessFiles } from '../src/application/readiness/index.js';
import { goldenConfigurationDocument } from './fixtures/checks-runtime-run.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

const RUN_ID = 'RUN-OLD';
const TASK_ID = 'TASK-OLD';
const TASK_BRANCH = 'foundry/TASK-OLD';
const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const DAY_MS = 86_400_000;

interface Fixture {
  readonly base: string;
  readonly target: string;
  readonly configPath: string;
  readonly runsRoot: string;
  readonly workspace: string;
  readonly cleanup: () => void;
}

function configurationOf(fixture: Fixture): void {
  // 055: artifact bounds are hardcoded, so the document carries no `artifacts`
  // block; retention tests advance TestClock past the fixed 30-day bound.
  const document = goldenConfigurationDocument(fixture.target, false);
  writeFileSync(fixture.configPath, JSON.stringify(document));
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-retention-'));
  const target = join(base, 'target');
  const runsRoot = join(target, '.agent', 'runs');
  const workspace = join(target, '.agent', 'worktrees', RUN_ID);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runsRoot, { recursive: true });
  const fixture: Fixture = {
    base,
    target,
    configPath: join(base, 'foundry.config.json'),
    runsRoot,
    workspace,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
  configurationOf(fixture);
  return fixture;
}

function runDirectoryOf(fixture: Fixture, runId = RUN_ID): string {
  return join(fixture.runsRoot, runId);
}

function writeIdentity(fixture: Fixture, runId = RUN_ID, taskId = TASK_ID): void {
  const runDirectory = runDirectoryOf(fixture, runId);
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(
    join(runDirectory, 'request-identity.json'),
    JSON.stringify({
      schemaVersion: 1,
      runId,
      taskId,
      sourceRequestPath: join(fixture.base, 'request.md'),
      originalByteLength: 12,
      originalContentHash: 'a'.repeat(64),
      normalizedByteLength: 12,
      normalizedPromptHash: 'b'.repeat(64),
    }),
  );
}

function emit(
  fixture: Fixture,
  runId: string,
  createIfMissing: boolean,
  draft: RunEventDraft,
): Effect.Effect<unknown, unknown, RunHistoryStorage> {
  return appendRunEvent({
    runDirectory: runDirectoryOf(fixture, runId),
    runId,
    createIfMissing,
    build: () => Effect.succeed(draft),
  });
}

function seedPlanning(fixture: Fixture, runId = RUN_ID, taskId = TASK_ID) {
  mkdirSync(runDirectoryOf(fixture, runId), { recursive: true });
  return Effect.gen(function* () {
    yield* emit(fixture, runId, true, { type: 'run-created', payload: { taskId } });
    yield* emit(fixture, runId, false, {
      type: 'source-frozen',
      payload: {
        repository: {
          repositoryRoot: fixture.target,
          gitDirectory: join(fixture.target, '.git'),
          remoteUrl: 'https://example.invalid/target.git',
        },
        sourceRemote: 'origin',
        sourceBranch: 'main',
        sourceCommit: FROZEN_COMMIT,
        taskBranch: TASK_BRANCH,
        workspace: fixture.workspace,
        expectedHead: FROZEN_COMMIT,
      },
    });
    yield* emit(fixture, runId, false, {
      type: 'guidance-frozen',
      payload: {
        sourceCommit: FROZEN_COMMIT,
        manifestPath: 'guidance-manifest.json',
        aggregateHash: 'f'.repeat(64),
        files: [],
      },
    });
    yield* emit(fixture, runId, false, {
      type: 'worktree-ready',
      payload: {
        taskBranch: TASK_BRANCH,
        workspace: fixture.workspace,
        headCommit: FROZEN_COMMIT,
        baseCommit: FROZEN_COMMIT,
      },
    });
    yield* emit(fixture, runId, false, {
      type: 'workflow-transition',
      payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function seedTerminal(fixture: Fixture, runId = RUN_ID, taskId = TASK_ID) {
  return Effect.gen(function* () {
    yield* seedPlanning(fixture, runId, taskId);
    yield* emit(fixture, runId, false, {
      type: 'workflow-transition',
      payload: { route: 'abandon-run', from: 'planning', to: 'abandoned', checkpoint: null },
    });
    writeFileSync(join(runDirectoryOf(fixture, runId), 'handoff.json'), '{}\n');
    mkdirSync(join(runDirectoryOf(fixture, runId), 'evidence'), { recursive: true });
    writeFileSync(join(runDirectoryOf(fixture, runId), 'evidence', 'checks.log'), 'log\n');
  }).pipe(Effect.provide(RunHistoryLive));
}

function fakeGit(): Layer.Layer<RunGit> {
  return Layer.succeed(
    RunGit,
    RunGit.of({
      inspectRepository: () => Effect.die(new Error('unused inspectRepository')),
      fetchSource: () => Effect.die(new Error('unused fetchSource')),
      commitExists: () => Effect.die(new Error('unused commitExists')),
      readBranch: ({ branch }) =>
        Effect.succeed({
          exists: branch === TASK_BRANCH,
          commit: branch === TASK_BRANCH ? FROZEN_COMMIT : null,
        }),
      createBranch: () => Effect.die(new Error('unused createBranch')),
      readWorktree: () => Effect.die(new Error('unused readWorktree')),
      createWorktree: () => Effect.die(new Error('unused createWorktree')),
      observeImplementation: () => Effect.die(new Error('unused observeImplementation')),
    }),
  );
}

function unusedLauncher(): Layer.Layer<RoleHostLauncher> {
  return Layer.succeed(
    RoleHostLauncher,
    RoleHostLauncher.of({
      launch: () => {
        throw new Error('unused role host launcher');
      },
    }),
  );
}

function applicationLayers(
  store: Layer.Layer<RunIdentityStore> = RunIdentityLive,
): Layer.Layer<ReadinessFiles | RunGit | RoleHostLauncher | RunIdentityStore | RunHistoryStorage> {
  return Layer.mergeAll(store, RunHistoryLive, ReadinessFilesLive, fakeGit(), unusedLauncher());
}

function failingWorkspaceStore(): Layer.Layer<RunIdentityStore> {
  return Layer.effect(
    RunIdentityStore,
    Effect.gen(function* () {
      const base = yield* RunIdentityStore;
      return RunIdentityStore.of({
        statPath: base.statPath,
        readFileBytes: base.readFileBytes,
        ensureParentDirectory: base.ensureParentDirectory,
        createRunDirectoryExclusive: base.createRunDirectoryExclusive,
        writeFileBytes: base.writeFileBytes,
        listRuns: base.listRuns,
        removeDirectory: (path) =>
          path.endsWith(RUN_ID)
            ? Effect.fail(
                new RunIdentityStorageError({ message: 'removal refused', runId: RUN_ID }),
              )
            : base.removeDirectory(path),
      });
    }),
  ).pipe(Layer.provide(RunIdentityLive));
}

describe('retention cleanup list', () => {
  it.effect('excludes nonterminal runs and includes terminal runs past retention', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeIdentity(fixture);
        yield* seedTerminal(fixture);
        writeIdentity(fixture, 'RUN-ACTIVE', 'TASK-ACTIVE');
        yield* seedPlanning(fixture, 'RUN-ACTIVE', 'TASK-ACTIVE');
        // The hardcoded retention bound is 30 days; advance past it so the
        // terminal run is honestly eligible while the active run is excluded.
        yield* TestClock.adjust(Duration.days(31));

        const report = yield* readRetentionCleanupList({
          configArg: fixture.configPath,
          cwd: fixture.base,
        }).pipe(Effect.provide(applicationLayers()));

        expect(report.retentionDays).toBe(30);
        expect(report.runs.map((run) => run.runId)).toEqual([RUN_ID]);
        expect(report.runs[0]?.workflowState).toBe('abandoned');
        expect(report.runs[0]?.ownership).toBe('owned');
        expect(report.runs[0]?.taskBranch).toBe(TASK_BRANCH);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('uses the terminal transition time, not file mtime', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeIdentity(fixture);
        yield* seedTerminal(fixture);
        const runDirectory = runDirectoryOf(fixture);

        const fresh = yield* readRetentionCleanupList({
          configArg: fixture.configPath,
          cwd: fixture.base,
        }).pipe(Effect.provide(applicationLayers()));
        expect(fresh.runs).toEqual([]);

        const aged = yield* Effect.gen(function* () {
          yield* TestClock.adjust(Duration.days(31));
          return yield* readRetentionCleanupList({
            configArg: fixture.configPath,
            cwd: fixture.base,
          });
        }).pipe(Effect.provide(applicationLayers()));
        expect(aged.runs.map((run) => run.runId)).toEqual([RUN_ID]);
        expect(aged.runs[0]?.terminalAt).toBe('1970-01-01T00:00:00.000Z');
        expect(aged.runs[0]?.ageMs).toBeGreaterThanOrEqual(31 * DAY_MS);
        expect(existsSync(runDirectory)).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('confirmed retention cleanup', () => {
  it.effect('refuses a nonterminal run and writes nothing', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeIdentity(fixture);
        yield* seedPlanning(fixture);

        const result = yield* runRetentionCleanup({
          configArg: fixture.configPath,
          cwd: fixture.base,
          runId: RUN_ID,
          confirm: RUN_ID,
        }).pipe(Effect.provide(applicationLayers()), Effect.result);

        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect(result.failure._tag).toBe('RetentionCleanupError');
          expect(result.failure.reason).toBe('nonterminal');
          expect(result.failure.kind).toBe('blocked');
        }
        expect(existsSync(fixture.workspace)).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('leaves the run untouched and names the failing check', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedTerminal(fixture);
        // Advance past the hardcoded 30-day bound so the run reaches the
        // ownership check instead of stopping as within-retention.
        yield* TestClock.adjust(Duration.days(31));

        const result = yield* runRetentionCleanup({
          configArg: fixture.configPath,
          cwd: fixture.base,
          runId: RUN_ID,
          confirm: RUN_ID,
        }).pipe(Effect.provide(applicationLayers()), Effect.result);

        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect(result.failure.reason).toBe('check-failed');
          expect(result.failure.check).toBe('ownership');
        }
        expect(existsSync(fixture.workspace)).toBe(true);
        expect(existsSync(join(runDirectoryOf(fixture), 'handoff.json'))).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('preserves the task branch and handoff while disposing owned resources', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeIdentity(fixture);
        yield* seedTerminal(fixture);
        // Advance past the hardcoded 30-day bound so the terminal run is
        // honestly eligible for disposal.
        yield* TestClock.adjust(Duration.days(31));

        const report = yield* runRetentionCleanup({
          configArg: fixture.configPath,
          cwd: fixture.base,
          runId: RUN_ID,
          confirm: RUN_ID,
        }).pipe(Effect.provide(applicationLayers()));

        expect(report.outcome).toBe('succeeded');
        expect(report.preserved.taskBranch).toBe(TASK_BRANCH);
        expect(report.preserved.handoffPath).toBe(join(runDirectoryOf(fixture), 'handoff.json'));
        expect(report.checks.every((check) => check.ok)).toBe(true);
        expect(existsSync(fixture.workspace)).toBe(false);
        expect(existsSync(join(runDirectoryOf(fixture), 'evidence'))).toBe(false);
        expect(existsSync(join(runDirectoryOf(fixture), 'handoff.json'))).toBe(true);
        expect(existsSync(join(runDirectoryOf(fixture), 'events.jsonl'))).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('allows partial success and keeps the run eligible afterwards', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeIdentity(fixture);
        yield* seedTerminal(fixture);
        // Advance past the hardcoded 30-day bound so the terminal run is
        // honestly eligible; the partial failure must keep it eligible.
        yield* TestClock.adjust(Duration.days(31));

        const layers = applicationLayers(failingWorkspaceStore());
        const report = yield* runRetentionCleanup({
          configArg: fixture.configPath,
          cwd: fixture.base,
          runId: RUN_ID,
          confirm: RUN_ID,
        }).pipe(Effect.provide(layers));
        expect(report.outcome).toBe('failed');
        expect(
          report.resources.some(
            (resource) => resource.kind === 'workspace' && resource.disposition === 'failed',
          ),
        ).toBe(true);
        expect(existsSync(join(runDirectoryOf(fixture), 'evidence'))).toBe(false);

        const again = yield* readRetentionCleanupList({
          configArg: fixture.configPath,
          cwd: fixture.base,
        }).pipe(Effect.provide(layers));
        expect(again.runs.map((run) => run.runId)).toEqual([RUN_ID]);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

function cliLayers(): Layer.Layer<
  RunGit | RoleHostLauncher | RunIdentityStore | RunHistoryStorage
> {
  return applicationLayers();
}

describe('retention cleanup CLI envelope', () => {
  it.effect('reports the eligible list with exit code 0', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeIdentity(fixture);
        yield* seedTerminal(fixture);
        // Advance past the hardcoded 30-day bound so the terminal run is
        // honestly eligible for listing.
        yield* TestClock.adjust(Duration.days(31));

        const result = yield* runCli([
          'cleanup',
          '--list',
          '--config',
          fixture.configPath,
          '--json',
        ]).pipe(Effect.provide(cliLayers()));

        expect(result.exitCode).toBe(0);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(true);
        if (!envelope.ok || !('runs' in envelope.data)) {
          throw new Error(`Expected a cleanup list envelope: ${result.stdout}`);
        }
        expect(envelope.command).toBe('cleanup');
        expect(envelope.data.runs.map((run) => run.runId)).toEqual([RUN_ID]);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('confirms deletion with exit code 0 and preserves the handoff', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeIdentity(fixture);
        yield* seedTerminal(fixture);
        // Advance past the hardcoded 30-day bound so the terminal run is
        // honestly eligible for confirmed disposal.
        yield* TestClock.adjust(Duration.days(31));

        const result = yield* runCli([
          'cleanup',
          '--config',
          fixture.configPath,
          '--run-id',
          RUN_ID,
          '--confirm',
          RUN_ID,
          '--json',
        ]).pipe(Effect.provide(cliLayers()));

        expect(result.exitCode).toBe(0);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(true);
        if (!envelope.ok || !('outcome' in envelope.data) || !('preserved' in envelope.data)) {
          throw new Error(`Expected a cleanup run envelope: ${result.stdout}`);
        }
        expect(envelope.data.outcome).toBe('succeeded');
        expect(envelope.data.preserved.taskBranch).toBe(TASK_BRANCH);
        expect(existsSync(join(runDirectoryOf(fixture), 'handoff.json'))).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses a nonterminal confirmation with exit code 1', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        writeIdentity(fixture);
        yield* seedPlanning(fixture);

        const result = yield* runCli([
          'cleanup',
          '--config',
          fixture.configPath,
          '--run-id',
          RUN_ID,
          '--confirm',
          RUN_ID,
          '--json',
        ]).pipe(Effect.provide(cliLayers()));

        expect(result.exitCode).toBe(1);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(false);
        if (envelope.ok) {
          throw new Error(`Expected a failure envelope: ${result.stdout}`);
        }
        expect(envelope.error.kind).toBe('blocked');
        expect(envelope.error.runId).toBe(RUN_ID);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
