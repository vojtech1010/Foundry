import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendRunEvent, readVerifiedRunHistory } from '../../src/application/run-history/index.js';
import { reconcileRunReports } from '../../src/application/run-identity/index.js';
import { interruptExitCodeFor } from '../../src/domain/public-commands.js';
import { WORKFLOW_STATE_FILENAME } from '../../src/domain/workflow.js';
import { RunHistoryLive } from '../../src/platform/run-history.js';

const RUN_ID = 'RUN-PARITY';

const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const TASK_BRANCH = 'foundry/parity';

const WORKSPACE = '/repo/.agent/worktrees/parity';

const RebuiltProgressJson = Schema.fromJsonString(
  Schema.Struct({ runId: Schema.String, state: Schema.String }),
);

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupRunDirectory(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-parity-resume-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function seedProvisioning(runDirectory: string) {
  return Effect.gen(function* () {
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: true,
      build: () =>
        Effect.succeed({ type: 'run-created', payload: { taskId: 'TASK-PARITY' } } as const),
    });
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'source-frozen',
          payload: {
            repository: {
              repositoryRoot: '/repo',
              gitDirectory: '/repo/.git',
              remoteUrl: 'https://example.invalid/repo.git',
            },
            sourceRemote: 'origin',
            sourceBranch: 'main',
            sourceCommit: FROZEN_COMMIT,
            taskBranch: TASK_BRANCH,
            workspace: WORKSPACE,
            expectedHead: FROZEN_COMMIT,
          },
        } as const),
    });
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'guidance-frozen',
          payload: {
            sourceCommit: FROZEN_COMMIT,
            manifestPath: 'guidance-manifest.json',
            aggregateHash: 'f'.repeat(64),
            files: [],
          },
        } as const),
    });
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'worktree-ready',
          payload: {
            taskBranch: TASK_BRANCH,
            workspace: WORKSPACE,
            headCommit: FROZEN_COMMIT,
            baseCommit: FROZEN_COMMIT,
          },
        } as const),
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function checkpointRun(runDirectory: string) {
  return Effect.gen(function* () {
    yield* seedProvisioning(runDirectory);
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'workflow-transition',
          payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
        } as const),
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

describe('interrupt and resume parity', () => {
  it('uses the host platform conventional interrupt exit code', () => {
    expect(interruptExitCodeFor(process.platform)).toBe(
      process.platform === 'win32' ? 0xc000013a : 130,
    );
    expect(interruptExitCodeFor('win32')).toBe(0xc000013a);
    expect(interruptExitCodeFor('linux')).toBe(130);
    expect(interruptExitCodeFor('darwin')).toBe(130);
  });

  it.effect('resumes the same run from verified checkpoints and rebuilds derived views', () => {
    const fixture = setupRunDirectory();
    return Effect.gen(function* () {
      yield* checkpointRun(fixture.runDirectory);

      const checkpoint = yield* readVerifiedRunHistory({
        runDirectory: fixture.runDirectory,
        runId: RUN_ID,
        createIfMissing: false,
      }).pipe(Effect.provide(RunHistoryLive));
      expect(checkpoint.head.revision).toBe(5);
      expect(checkpoint.derived.state).toBe('planning');

      // An interrupted process may leave a disagreeing derived view. Resume must
      // rebuild it from verified history rather than trust the stale file.
      writeFileSync(
        join(fixture.runDirectory, WORKFLOW_STATE_FILENAME),
        `${JSON.stringify({
          schemaVersion: 1,
          runId: 'RUN-OTHER',
          state: 'completed',
          checkpoint: null,
          attempts: {},
        })}\n`,
      );

      const resumed = yield* reconcileRunReports({
        runDirectory: fixture.runDirectory,
        runId: RUN_ID,
      }).pipe(Effect.provide(RunHistoryLive));
      expect(resumed.runId).toBe(RUN_ID);
      expect(resumed.workflowState).toBe('planning');

      const rebuilt = Schema.decodeUnknownSync(RebuiltProgressJson)(
        readFileSync(join(fixture.runDirectory, WORKFLOW_STATE_FILENAME), 'utf8'),
      );
      expect(rebuilt.runId).toBe(RUN_ID);
      expect(rebuilt.state).toBe('planning');
    }).pipe(Effect.ensuring(Effect.sync(fixture.cleanup)));
  });
});
