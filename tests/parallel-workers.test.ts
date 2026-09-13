import { describe, expect, it } from '@effect/vitest';
import { Duration, Effect, Layer } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decideWorkerBranch,
  workerAttemptNumber,
  workerBranchName,
  workerRunHash,
  workerWorkspacePath,
} from '../src/domain/parallel-workers.js';
import { RunGit, RunWorkspaceBlocked } from '../src/application/git-provisioning/index.js';
import {
  WorkerTurnRunner,
  runObjectiveWorkers,
} from '../src/application/parallel-workers/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { RoleHost, RoleHostLauncher } from '../src/application/role-conversations/index.js';
import { RoleTurnResourceObserver } from '../src/application/role-permissions/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';

import type { PlannedObjective } from '../src/domain/architect-plan.js';
import type { RunEventDraft } from '../src/domain/run-history.js';
import type { WorkerTurnOutcome } from '../src/application/parallel-workers/index.js';

const RUN_ID = 'RUN-PAR';

const BASE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const COMMITS = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)];

const TASK_BRANCH = 'foundry/TASK-PAR';

const WORKSPACE = '/target/.agent/worktrees/TASK-PAR';

function objectiveIds(count: number): ReadonlyArray<string> {
  return Array.from({ length: count }, (_, index) => `OBJ-${String(index + 1).padStart(3, '0')}`);
}

function plannedObjectives(count: number): ReadonlyArray<PlannedObjective> {
  return objectiveIds(count).map((id, index) => ({
    id,
    title: `Objective ${index + 1}`,
    affectedPaths: [`src/part-${index + 1}.ts`],
    criterionIds: [`AC-${String(index + 1).padStart(3, '0')}`],
  }));
}

function branchFor(objectiveId: string): string {
  return workerBranchName(TASK_BRANCH, objectiveId, RUN_ID);
}

function workspaceFor(objectiveId: string): string {
  return workerWorkspacePath(WORKSPACE, objectiveId, RUN_ID);
}

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-parallel-workers-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return { runDirectory, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function emit(runDirectory: string, createIfMissing: boolean, draft: RunEventDraft) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing,
    build: () => Effect.succeed(draft),
  });
}

function seedParallelCoding(fixture: Fixture, count: number) {
  const objectives = plannedObjectives(count);
  return Effect.gen(function* () {
    yield* emit(fixture.runDirectory, true, {
      type: 'run-created',
      payload: { taskId: 'TASK-PAR' },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'source-frozen',
      payload: {
        repository: {
          repositoryRoot: '/target',
          gitDirectory: '/target/.git',
          remoteUrl: 'https://example.invalid/target.git',
        },
        sourceRemote: 'origin',
        sourceBranch: 'main',
        sourceCommit: BASE_COMMIT,
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        expectedHead: BASE_COMMIT,
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'guidance-frozen',
      payload: {
        sourceCommit: BASE_COMMIT,
        manifestPath: 'guidance-manifest.json',
        aggregateHash: 'f'.repeat(64),
        files: [],
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'worktree-ready',
      payload: {
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        headCommit: BASE_COMMIT,
        baseCommit: BASE_COMMIT,
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'plan-accepted',
      payload: {
        outcome: 'plan_ready',
        criteria: objectives.map((objective) => ({
          id: objective.criterionIds[0] ?? 'AC-001',
          text: `${objective.title} criterion`,
        })),
        runtimeValidationRequired: false,
        execution: { mode: 'parallel', objectives },
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'plan-accepted', from: 'planning', to: 'coding', checkpoint: null },
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

interface FakeGit {
  readonly layer: Layer.Layer<RunGit>;
  readonly branches: Map<string, string>;
  readonly worktrees: Map<string, { branch: string; head: string }>;
  readonly commits: Map<string, string>;
  readonly createdBranches: Array<string>;
  readonly createdWorktrees: Array<string>;
}

function fakeGit(): FakeGit {
  const branches = new Map<string, string>();
  const worktrees = new Map<string, { branch: string; head: string }>();
  const commits = new Map<string, string>();
  const createdBranches: Array<string> = [];
  const createdWorktrees: Array<string> = [];
  const unused = (name: string) => Effect.die(new Error(`unexpected RunGit.${name}`));
  const layer = Layer.succeed(
    RunGit,
    RunGit.of({
      inspectRepository: () => unused('inspectRepository'),
      fetchSource: () => unused('fetchSource'),
      commitExists: () => unused('commitExists'),
      readBranch: ({ branch }) =>
        Effect.succeed({ exists: branches.has(branch), commit: branches.get(branch) ?? null }),
      createBranch: ({ branch, commit }) =>
        Effect.sync(() => {
          branches.set(branch, commit);
          createdBranches.push(branch);
        }),
      readWorktree: ({ workspace }) => {
        const worktree = worktrees.get(workspace);
        return Effect.succeed(
          worktree === undefined
            ? { registered: false, checkedOutBranch: null, headCommit: null }
            : {
                registered: true,
                checkedOutBranch: worktree.branch,
                headCommit: worktree.head,
              },
        );
      },
      createWorktree: ({ workspace, branch }) =>
        Effect.sync(() => {
          worktrees.set(workspace, { branch, head: branches.get(branch) ?? BASE_COMMIT });
          createdWorktrees.push(workspace);
        }),
      observeImplementation: ({ workspace, taskBranch, baseCommit }) => {
        const commit = commits.get(workspace);
        return Effect.succeed({
          workspaceExists: true,
          currentBranch: taskBranch,
          headCommit: commit ?? baseCommit,
          clean: true,
          baseIsAncestor: true,
          changedFiles: commit === undefined ? [] : ['src/objective.ts'],
        });
      },
    }),
  );
  return { layer, branches, worktrees, commits, createdBranches, createdWorktrees };
}

const DummyHost = Layer.succeed(
  RoleHost,
  RoleHost.of({
    capabilities: () => Effect.die(new Error('the fake runner provides no host')),
    create: () => Effect.die(new Error('the fake runner provides no host')),
    submit: () => Effect.die(new Error('the fake runner provides no host')),
    observe: () => Effect.die(new Error('the fake runner provides no host')),
    stop: () => Effect.die(new Error('the fake runner provides no host')),
  }),
);

const DummyLauncher = Layer.succeed(
  RoleHostLauncher,
  RoleHostLauncher.of({ launch: () => DummyHost }),
);

const DummyObserver = Layer.succeed(
  RoleTurnResourceObserver,
  RoleTurnResourceObserver.of({
    fingerprint: () => Effect.die(new Error('the fake runner observes nothing')),
  }),
);

type RunnerHandler = (target: {
  readonly objectiveId: string;
  readonly workspace: string;
  readonly attempt: number;
}) => Effect.Effect<WorkerTurnOutcome, never, never>;

function runnerLayer(handler: RunnerHandler): Layer.Layer<WorkerTurnRunner> {
  return Layer.succeed(
    WorkerTurnRunner,
    WorkerTurnRunner.of({
      run: (target) => handler(target),
    }),
  );
}

function runWorkers(
  fixture: Fixture,
  git: FakeGit,
  runner: Layer.Layer<WorkerTurnRunner>,
  options: {
    readonly count: number;
    readonly maxParallelCoders: number;
    readonly coderRetryBudget: number;
  },
) {
  return runObjectiveWorkers({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    repositoryRoot: '/target',
    taskBranch: TASK_BRANCH,
    baseCommit: BASE_COMMIT,
    workspace: WORKSPACE,
    maxParallelCoders: options.maxParallelCoders,
    coderRetryBudget: options.coderRetryBudget,
    objectives: plannedObjectives(options.count),
  }).pipe(
    Effect.provide(Layer.mergeAll(git.layer, runner, DummyLauncher, DummyObserver, RunHistoryLive)),
  );
}

function readWorkers(fixture: Fixture) {
  return readVerifiedRunHistory({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

describe('worker naming and collision rules', () => {
  it('derives the run hash from the run id and names branches deterministically', () => {
    const hash = workerRunHash(RUN_ID);
    expect(hash).toHaveLength(12);
    expect(hash).toMatch(/^[0-9a-f]{12}$/u);
    expect(branchFor('OBJ-001')).toBe(`${TASK_BRANCH}--worker-OBJ-001-${hash}`);
    expect(workspaceFor('OBJ-001')).toBe(`${WORKSPACE}--worker-OBJ-001-${hash}`);
  });

  it('reserves disjoint attempt blocks per objective', () => {
    const first = [1, 2, 3].map((local) => workerAttemptNumber(0, local, 3));
    const second = [1, 2, 3].map((local) => workerAttemptNumber(1, local, 3));
    expect(first).toEqual([1, 2, 3]);
    expect(second).toEqual([4, 5, 6]);
    expect(new Set([...first, ...second]).size).toBe(6);
  });

  it('creates an unowned branch, reuses an owned matching branch, and blocks a foreign one', () => {
    expect(
      decideWorkerBranch({
        branchExists: false,
        branchHead: null,
        ownedByThisRun: false,
        recordedHead: null,
        settled: false,
      }),
    ).toEqual({ kind: 'create' });
    expect(
      decideWorkerBranch({
        branchExists: true,
        branchHead: BASE_COMMIT,
        ownedByThisRun: true,
        recordedHead: BASE_COMMIT,
        settled: false,
      }),
    ).toEqual({ kind: 'reuse' });
    const blocked = decideWorkerBranch({
      branchExists: true,
      branchHead: COMMITS[3]!,
      ownedByThisRun: false,
      recordedHead: null,
      settled: false,
    });
    expect(blocked.kind).toBe('blocked');
  });
});

describe('parallel objective worker orchestration', () => {
  it.live('bounds active workers by maxParallelCoders and binds commits to worker records', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedParallelCoding(fixture, 3);
        const git = fakeGit();
        let active = 0;
        let maxActive = 0;
        const commitsByObjective = new Map<string, string>([
          ['OBJ-001', COMMITS[0]!],
          ['OBJ-002', COMMITS[1]!],
          ['OBJ-003', COMMITS[2]!],
        ]);
        const runner = runnerLayer((target) =>
          Effect.gen(function* () {
            active += 1;
            maxActive = Math.max(maxActive, active);
            yield* Effect.sleep(Duration.millis(5));
            const commit = commitsByObjective.get(target.objectiveId);
            if (commit !== undefined) {
              git.commits.set(target.workspace, commit);
            }
            active -= 1;
            return {
              kind: 'settled',
              sessionId: `session-${target.objectiveId}-${target.attempt}`,
              attempt: target.attempt,
              generation: target.attempt,
            } as const;
          }),
        );

        const report = yield* runWorkers(fixture, git, runner, {
          count: 3,
          maxParallelCoders: 2,
          coderRetryBudget: 1,
        });
        expect(report.allSettled).toBe(true);
        expect(report.objectives).toHaveLength(3);
        expect(maxActive).toBe(2);

        const history = yield* readWorkers(fixture);
        const workers = history.derived.objectiveWorkers ?? [];
        for (const objectiveId of objectiveIds(3)) {
          const settled = workers.find(
            (worker) =>
              worker.objectiveId === objectiveId &&
              worker.phase === 'settled' &&
              worker.commit !== null,
          );
          expect(settled?.commit).toBe(commitsByObjective.get(objectiveId));
          expect(
            workers.some(
              (worker) => worker.objectiveId === objectiveId && worker.phase === 'disposed',
            ),
          ).toBe(true);
        }
        expect(git.createdBranches.sort()).toEqual(
          objectiveIds(3)
            .map((id) => branchFor(id))
            .sort(),
        );
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('keeps each objective retry budget independent', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedParallelCoding(fixture, 2);
        const git = fakeGit();
        const attemptsByObjective = new Map<string, number>();
        const runner = runnerLayer((target) => {
          attemptsByObjective.set(
            target.objectiveId,
            (attemptsByObjective.get(target.objectiveId) ?? 0) + 1,
          );
          if (target.objectiveId === 'OBJ-002') {
            return Effect.succeed({
              kind: 'control-invalid',
              sessionId: `session-${target.objectiveId}-${target.attempt}`,
              attempt: target.attempt,
              generation: target.attempt,
              problem: 'the scripted control envelope is invalid',
            } as const);
          }
          git.commits.set(target.workspace, COMMITS[0]!);
          return Effect.succeed({
            kind: 'settled',
            sessionId: `session-${target.objectiveId}-${target.attempt}`,
            attempt: target.attempt,
            generation: target.attempt,
          } as const);
        });

        const report = yield* runWorkers(fixture, git, runner, {
          count: 2,
          maxParallelCoders: 2,
          coderRetryBudget: 1,
        });
        expect(report.allSettled).toBe(false);
        const first = report.objectives.find((outcome) => outcome.objectiveId === 'OBJ-001');
        const second = report.objectives.find((outcome) => outcome.objectiveId === 'OBJ-002');
        expect(first).toMatchObject({ settled: true, commit: COMMITS[0], attempts: 1 });
        expect(second).toMatchObject({ settled: false, commit: null, attempts: 2 });
        expect(attemptsByObjective.get('OBJ-001')).toBe(1);
        expect(attemptsByObjective.get('OBJ-002')).toBe(2);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('rejects a foreign-owned worker branch without moving it', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedParallelCoding(fixture, 1);
        const git = fakeGit();
        const foreignCommit = COMMITS[3]!;
        git.branches.set(branchFor('OBJ-001'), foreignCommit);
        const runner = runnerLayer(() =>
          Effect.die(new Error('a colliding worker must never run a Coder turn')),
        );

        const error = yield* runWorkers(fixture, git, runner, {
          count: 1,
          maxParallelCoders: 1,
          coderRetryBudget: 1,
        }).pipe(Effect.flip);
        expect(error).toBeInstanceOf(RunWorkspaceBlocked);
        expect(git.branches.get(branchFor('OBJ-001'))).toBe(foreignCommit);
        expect(git.createdBranches).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('skips already settled objectives on a resumed orchestration', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedParallelCoding(fixture, 1);
        const git = fakeGit();
        const successful = runnerLayer((target) => {
          git.commits.set(target.workspace, COMMITS[0]!);
          return Effect.succeed({
            kind: 'settled',
            sessionId: `session-${target.objectiveId}-${target.attempt}`,
            attempt: target.attempt,
            generation: target.attempt,
          } as const);
        });
        yield* runWorkers(fixture, git, successful, {
          count: 1,
          maxParallelCoders: 1,
          coderRetryBudget: 1,
        });
        const before = yield* readWorkers(fixture);
        const settledBefore = (before.derived.objectiveWorkers ?? []).filter(
          (worker) => worker.phase === 'settled',
        ).length;

        const resumed = runnerLayer(() =>
          Effect.die(new Error('a settled objective must not run another Coder turn')),
        );
        const report = yield* runWorkers(fixture, git, resumed, {
          count: 1,
          maxParallelCoders: 1,
          coderRetryBudget: 1,
        });
        expect(report.allSettled).toBe(true);

        const after = yield* readWorkers(fixture);
        const settledAfter = (after.derived.objectiveWorkers ?? []).filter(
          (worker) => worker.phase === 'settled',
        ).length;
        expect(settledAfter).toBe(settledBefore);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
