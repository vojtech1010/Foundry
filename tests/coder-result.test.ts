import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CoderTurnRejected, handleCoderTurn } from '../src/application/coder-result/index.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { transitionWorkflow } from '../src/application/workflow-transitions/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';

import type { ImplementationObservation } from '../src/application/git-provisioning/index.js';

const RUN_ID = 'RUN-CODER';

const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const TASK_BRANCH = 'foundry/RUN-CODER';

const WORKSPACE = '/target/.agent/worktrees/RUN-CODER';

const IMPLEMENTED_COMMIT = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

const LiveStore = Layer.mergeAll(RunIdentityLive, RunHistoryLive);

const CLEAN: ImplementationObservation = {
  workspaceExists: true,
  currentBranch: TASK_BRANCH,
  headCommit: IMPLEMENTED_COMMIT,
  clean: true,
  baseIsAncestor: true,
  changedFiles: ['src/implementation.ts'],
};

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-coder-result-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function gitLayer(observation: ImplementationObservation): Layer.Layer<RunGit> {
  const unused = (name: string) =>
    Effect.die(new Error(`coder-result tests must not call RunGit.${name}`));
  return Layer.succeed(
    RunGit,
    RunGit.of({
      inspectRepository: () => unused('inspectRepository'),
      fetchSource: () => unused('fetchSource'),
      commitExists: () => unused('commitExists'),
      readBranch: () => unused('readBranch'),
      createBranch: () => unused('createBranch'),
      readWorktree: () => unused('readWorktree'),
      createWorktree: () => unused('createWorktree'),
      observeImplementation: () => Effect.succeed(observation),
    }),
  );
}

const GIT = gitLayer(CLEAN);

function seedCoding(fixture: Fixture) {
  return Effect.gen(function* () {
    yield* appendRunEvent({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      createIfMissing: true,
      build: () =>
        Effect.succeed({ type: 'run-created', payload: { taskId: 'TASK-CODER' } } as const),
    });
    yield* appendRunEvent({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
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
            workspace: WORKSPACE,
            expectedHead: FROZEN_COMMIT,
          },
        } as const),
    });
    yield* appendRunEvent({
      runDirectory: fixture.runDirectory,
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
      runDirectory: fixture.runDirectory,
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
    yield* transitionWorkflow({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      request: {
        route: 'run-created',
        provisioning: { source: true, lease: true, storage: true, worktree: true },
      },
    });
    yield* appendRunEvent({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'plan-accepted',
          payload: {
            outcome: 'plan_ready' as const,
            criteria: [{ id: 'AC-001', text: 'the criterion' }],
            runtimeValidationRequired: false,
            execution: {
              mode: 'sequential' as const,
              objectives: [
                {
                  id: 'OBJ-001',
                  title: 'Implement the accepted plan',
                  affectedPaths: ['.'],
                  criterionIds: ['AC-001'],
                },
              ],
            },
          },
        } as const),
    });
    yield* transitionWorkflow({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      request: { route: 'plan-accepted' },
    });
  }).pipe(Effect.provide(GIT), Effect.provide(LiveStore));
}

function readHistory(fixture: Fixture) {
  return readVerifiedRunHistory({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

describe('blocked coder turn', () => {
  it.effect('preserves evidence without recording a result or transitioning', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedCoding(fixture);
        const disposition = yield* handleCoderTurn({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          control: { schemaVersion: 1, outcome: 'blocked' },
        }).pipe(Effect.provide(GIT), Effect.provide(LiveStore));
        expect(disposition.outcome).toBe('blocked');

        const history = yield* readHistory(fixture);
        expect(history.derived.state).toBe('coding');
        expect(history.derived.implementation).toBeNull();
        expect(history.derived.worktreeReady).not.toBeNull();
        expect(history.events.some((event) => event.type === 'implementation-accepted')).toBe(
          false,
        );
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('rejects an unknown or open control envelope without a result', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedCoding(fixture);
        const error = yield* handleCoderTurn({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          control: { schemaVersion: 1, outcome: 'maybe' },
        }).pipe(Effect.provide(GIT), Effect.provide(LiveStore), Effect.flip);
        expect(error).toBeInstanceOf(CoderTurnRejected);
        const history = yield* readHistory(fixture);
        expect(history.derived.state).toBe('coding');
        expect(history.derived.implementation).toBeNull();
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('routes an implemented turn through the Git-derived implementation commit', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedCoding(fixture);
        const disposition = yield* handleCoderTurn({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          control: { schemaVersion: 1, outcome: 'implemented' },
        }).pipe(Effect.provide(GIT), Effect.provide(LiveStore));
        expect(disposition.outcome).toBe('implemented');
        const history = yield* readHistory(fixture);
        expect(history.derived.state).toBe('verifying');
        expect(history.derived.implementation?.commit).toBe(IMPLEMENTED_COMMIT);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
