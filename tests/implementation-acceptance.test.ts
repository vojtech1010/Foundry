import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunGit } from '../src/application/git-provisioning/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import {
  IllegalWorkflowTransition,
  transitionWorkflow,
} from '../src/application/workflow-transitions/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';

import type { ImplementationObservation } from '../src/application/git-provisioning/index.js';
import type { WorkflowTransitionRequest } from '../src/domain/workflow.js';

const RUN_ID = 'RUN-IMPL';

const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const TASK_BRANCH = 'foundry/RUN-IMPL';

const WORKSPACE = '/target/.agent/worktrees/RUN-IMPL';

const IMPLEMENTED_COMMIT = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

const LiveStore = Layer.mergeAll(RunIdentityLive, RunHistoryLive);

const CLEAN: ImplementationObservation = {
  workspaceExists: true,
  currentBranch: TASK_BRANCH,
  headCommit: IMPLEMENTED_COMMIT,
  clean: true,
  baseIsAncestor: true,
  changedFiles: ['src/domain/thing.ts', 'tests/thing.test.ts'],
};

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-implementation-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function observingGit(observation: ImplementationObservation): Layer.Layer<RunGit> {
  const unused = (name: string) =>
    Effect.die(new Error(`implementation tests must not call ${name}`));
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

function seedCoding(fixture: Fixture) {
  return Effect.gen(function* () {
    yield* appendRunEvent({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      createIfMissing: true,
      build: () =>
        Effect.succeed({ type: 'run-created', payload: { taskId: 'TASK-IMPL' } } as const),
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
  }).pipe(Effect.provide(LiveStore));
}

function transition(
  fixture: Fixture,
  request: WorkflowTransitionRequest,
  observation: ImplementationObservation = CLEAN,
) {
  return transitionWorkflow({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    request,
  }).pipe(Effect.provide(observingGit(observation)), Effect.provide(LiveStore));
}

function readHistory(fixture: Fixture) {
  return readVerifiedRunHistory({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

describe('implementation acceptance provenance', () => {
  it.effect('records the Git-derived commit before the verification route', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedCoding(fixture);
        yield* transition(fixture, {
          route: 'run-created',
          provisioning: { source: true, lease: true, storage: true, worktree: true },
        });
        yield* transition(fixture, { route: 'plan-accepted', planRequiresImplementation: true });

        const report = yield* transition(fixture, {
          route: 'implementation-ready',
          branchClean: true,
          candidateCommit: null,
          noChangeCandidateValidated: false,
        });
        expect(report.workflowState).toBe('verifying');

        const history = yield* readHistory(fixture);
        const implementation = history.derived.implementation;
        expect(implementation).toMatchObject({
          taskBranch: TASK_BRANCH,
          baseCommit: FROZEN_COMMIT,
          commit: IMPLEMENTED_COMMIT,
          noChangeCandidate: false,
          changedFiles: ['src/domain/thing.ts', 'tests/thing.test.ts'],
        });
        expect(history.derived.state).toBe('verifying');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses a dirty branch without recording an accepted implementation', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedCoding(fixture);
        yield* transition(fixture, {
          route: 'run-created',
          provisioning: { source: true, lease: true, storage: true, worktree: true },
        });
        yield* transition(fixture, { route: 'plan-accepted', planRequiresImplementation: true });

        const error = yield* transition(
          fixture,
          {
            route: 'implementation-ready',
            branchClean: true,
            candidateCommit: null,
            noChangeCandidateValidated: false,
          },
          { ...CLEAN, clean: false },
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(IllegalWorkflowTransition);

        const history = yield* readHistory(fixture);
        expect(history.derived.implementation).toBeNull();
        expect(history.derived.state).toBe('coding');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('records a validated no-change candidate without a commit', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedCoding(fixture);
        yield* transition(fixture, {
          route: 'run-created',
          provisioning: { source: true, lease: true, storage: true, worktree: true },
        });
        yield* transition(fixture, { route: 'plan-accepted', planRequiresImplementation: true });

        yield* transition(
          fixture,
          {
            route: 'implementation-ready',
            branchClean: true,
            candidateCommit: null,
            noChangeCandidateValidated: true,
          },
          { ...CLEAN, headCommit: FROZEN_COMMIT, changedFiles: [] },
        );

        const history = yield* readHistory(fixture);
        expect(history.derived.implementation).toMatchObject({
          commit: null,
          noChangeCandidate: true,
          changedFiles: [],
        });
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
