import { Context, Effect, Schema } from 'effect';

import { isLegalGitBranchName } from '../../domain/run-locations.js';
import {
  decideWorkerBranch,
  workerAttemptNumber,
  workerBranchName,
  workerWorkspacePath,
} from '../../domain/parallel-workers.js';
import { RunGit, RunWorkspaceBlocked } from '../git-provisioning/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';

import type { PlannedObjective } from '../../domain/architect-plan.js';
import type { ObjectiveWorkerPayload } from '../../domain/run-history.js';
import type { RoleHostLauncher } from '../role-conversations/index.js';
import type { RoleTurnResourceObserver } from '../role-permissions/index.js';
import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';

export class ParallelWorkersTurnError extends Schema.TaggedError<ParallelWorkersTurnError>()(
  'ParallelWorkersTurnError',
  {
    message: Schema.String,
    runId: Schema.String,
    objectiveId: Schema.String,
    reason: Schema.String,
  },
) {}

export interface WorkerTurnTarget {
  readonly objectiveId: string;
  readonly attempt: number;
  readonly generation: number;
  readonly branch: string;
  readonly workspace: string;
}

export type WorkerTurnOutcome =
  | {
      readonly kind: 'settled';
      readonly sessionId: string;
      readonly attempt: number;
      readonly generation: number;
    }
  | {
      readonly kind: 'control-invalid';
      readonly sessionId: string;
      readonly attempt: number;
      readonly generation: number;
      readonly problem: string;
    }
  | {
      readonly kind: 'blocked';
      readonly sessionId: string;
      readonly attempt: number;
      readonly generation: number;
      readonly problem: string;
    };

/**
 * The one seam the orchestrator does not own: running a single Coder turn in a
 * worker's own session and worktree. The composition root provides it so worker
 * orchestration stays independent of the role-host details.
 */
export type WorkerTurnRequirements =
  | RoleHostLauncher
  | RoleTurnResourceObserver
  | RunHistoryStorage;

export class WorkerTurnRunner extends Context.Service<
  WorkerTurnRunner,
  {
    readonly run: (
      target: WorkerTurnTarget,
    ) => Effect.Effect<WorkerTurnOutcome, ParallelWorkersTurnError, WorkerTurnRequirements>;
  }
>()('foundry/application/parallel-workers/WorkerTurnRunner') {}

export interface ObjectiveWorkerOutcome {
  readonly objectiveId: string;
  readonly branch: string;
  readonly workspace: string;
  readonly attempts: number;
  readonly settled: boolean;
  readonly commit: string | null;
  readonly problem: string | null;
}

export interface ParallelWorkersReport {
  readonly objectives: ReadonlyArray<ObjectiveWorkerOutcome>;
  readonly allSettled: boolean;
}

export interface RunObjectiveWorkersOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly taskBranch: string;
  readonly baseCommit: string;
  readonly workspace: string;
  readonly maxParallelCoders: number;
  readonly coderRetryBudget: number;
  readonly objectives: ReadonlyArray<PlannedObjective>;
}

interface ObservedWorkerCommit {
  readonly commit: string | null;
  readonly problem: string | null;
  readonly changedFiles: ReadonlyArray<string>;
}

function workerBlocked(options: RunObjectiveWorkersOptions, problem: string): RunWorkspaceBlocked {
  return new RunWorkspaceBlocked({
    message: `Run "${options.runId}" cannot provision a parallel objective worker: ${problem}. A person must investigate before this run continues.`,
    runId: options.runId,
    problem,
  });
}

function appendWorkerEvent(
  options: RunObjectiveWorkersOptions,
  payload: ObjectiveWorkerPayload,
): Effect.Effect<void, RunHistoryError, RunHistoryStorage> {
  return appendRunEvent({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
    build: () => Effect.succeed({ type: 'objective-worker', payload } as const),
  });
}

function attemptsUsed(records: ReadonlyArray<ObjectiveWorkerPayload>): number {
  const attempts = new Set<number>();
  for (const record of records) {
    if (record.phase === 'settled') {
      attempts.add(record.attempt);
    }
  }
  return attempts.size;
}

function lastSettledCommit(records: ReadonlyArray<ObjectiveWorkerPayload>): string | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record !== undefined && record.phase === 'settled' && record.commit !== null) {
      return record.commit;
    }
  }
  return null;
}

const provisionWorker = Effect.fn('runObjectiveWorkers.provisionWorker')(function* (
  git: RunGit['Service'],
  options: RunObjectiveWorkersOptions,
  branch: string,
  workspace: string,
  records: ReadonlyArray<ObjectiveWorkerPayload>,
): Effect.fn.Return<void, RunWorkspaceBlocked, RunGit> {
  const owned = records.length > 0;
  const settled = records.some((record) => record.phase === 'settled' && record.commit !== null);
  const recordedHead = settled ? lastSettledCommit(records) : owned ? options.baseCommit : null;
  const observed = yield* git.readBranch({
    repositoryRoot: options.repositoryRoot,
    branch,
    runId: options.runId,
  });
  const decision = decideWorkerBranch({
    branchExists: observed.exists,
    branchHead: observed.commit,
    ownedByThisRun: owned,
    recordedHead,
    settled,
  });
  if (decision.kind === 'blocked') {
    return yield* workerBlocked(options, `branch "${branch}" ${decision.problem}`);
  }
  if (decision.kind === 'create') {
    yield* git.createBranch({
      repositoryRoot: options.repositoryRoot,
      branch,
      commit: options.baseCommit,
      runId: options.runId,
    });
  }

  const worktree = yield* git.readWorktree({
    repositoryRoot: options.repositoryRoot,
    workspace,
    runId: options.runId,
  });
  if (worktree.registered) {
    if (worktree.checkedOutBranch !== branch || worktree.headCommit !== options.baseCommit) {
      return yield* workerBlocked(
        options,
        `workspace ${workspace} is registered to ${
          worktree.checkedOutBranch === null
            ? 'a detached HEAD'
            : `branch "${worktree.checkedOutBranch}"`
        } at ${worktree.headCommit ?? 'an unknown commit'} instead of branch "${branch}" at ${options.baseCommit}; it was left untouched`,
      );
    }
    return;
  }
  yield* git.createWorktree({
    repositoryRoot: options.repositoryRoot,
    workspace,
    branch,
    runId: options.runId,
  });
});

const observeWorkerCommit = Effect.fn('runObjectiveWorkers.observeWorkerCommit')(function* (
  git: RunGit['Service'],
  options: RunObjectiveWorkersOptions,
  branch: string,
  workspace: string,
): Effect.fn.Return<ObservedWorkerCommit, RunWorkspaceBlocked, RunGit> {
  const observed = yield* git.observeImplementation({
    workspace,
    taskBranch: branch,
    baseCommit: options.baseCommit,
    runId: options.runId,
  });
  if (!observed.workspaceExists) {
    return yield* workerBlocked(options, `worker workspace ${workspace} does not exist`);
  }
  if (observed.currentBranch !== branch) {
    return yield* workerBlocked(
      options,
      `worker workspace ${workspace} is on ${
        observed.currentBranch === null ? 'a detached HEAD' : `branch "${observed.currentBranch}"`
      } instead of "${branch}"`,
    );
  }
  if (observed.headCommit === null) {
    return yield* workerBlocked(
      options,
      `worker workspace ${workspace} has no readable HEAD commit`,
    );
  }
  if (!observed.baseIsAncestor) {
    return yield* workerBlocked(
      options,
      `worker HEAD ${observed.headCommit} is not descended from the frozen source ${options.baseCommit}`,
    );
  }
  if (observed.headCommit === options.baseCommit) {
    return {
      commit: null,
      problem: 'the objective Coder turn did not produce a new commit',
      changedFiles: [],
    };
  }
  if (!observed.clean) {
    return {
      commit: null,
      problem: 'the objective Coder turn left uncommitted changes and no accepted commit',
      changedFiles: observed.changedFiles,
    };
  }
  return { commit: observed.headCommit, problem: null, changedFiles: observed.changedFiles };
});

const runOneObjective = Effect.fn('runObjectiveWorkers.runOneObjective')(function* (
  options: RunObjectiveWorkersOptions,
  git: RunGit['Service'],
  objective: PlannedObjective,
  index: number,
): Effect.fn.Return<
  ObjectiveWorkerOutcome,
  RunWorkspaceBlocked | RunHistoryError | ParallelWorkersTurnError,
  RunGit | RunHistoryStorage | WorkerTurnRunner | WorkerTurnRequirements
> {
  const branch = workerBranchName(options.taskBranch, objective.id, options.runId);
  const workspace = workerWorkspacePath(options.workspace, objective.id, options.runId);
  if (!isLegalGitBranchName(branch)) {
    return yield* workerBlocked(
      options,
      `derived worker branch "${branch}" is not a legal Git name`,
    );
  }

  const history = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  const records: Array<ObjectiveWorkerPayload> = [
    ...(history.derived.objectiveWorkers ?? []),
  ].filter((record) => record.objectiveId === objective.id);
  const completed = lastSettledCommit(records);
  if (completed !== null) {
    return {
      objectiveId: objective.id,
      branch,
      workspace,
      attempts: attemptsUsed(records),
      settled: true,
      commit: completed,
      problem: null,
    };
  }

  yield* provisionWorker(git, options, branch, workspace, records);

  const runner = yield* WorkerTurnRunner;
  const maxAttempts = Math.max(1, options.coderRetryBudget + 1);
  let problem: string | null = null;
  let lastSessionId = '';
  let lastAttempt = 0;
  let lastGeneration = 0;

  while (attemptsUsed(records) < maxAttempts) {
    const localAttempt = attemptsUsed(records) + 1;
    const attempt = workerAttemptNumber(index, localAttempt, maxAttempts);
    const turn = yield* runner.run({
      objectiveId: objective.id,
      attempt,
      generation: attempt,
      branch,
      workspace,
    });
    lastSessionId = turn.sessionId;
    lastAttempt = turn.attempt;
    lastGeneration = turn.generation;

    const observed: ObservedWorkerCommit = yield* observeWorkerCommit(
      git,
      options,
      branch,
      workspace,
    );
    const created: ObjectiveWorkerPayload = {
      phase: 'created',
      objectiveId: objective.id,
      sessionId: turn.sessionId,
      attempt: turn.attempt,
      generation: turn.generation,
      commit: null,
    };
    yield* appendWorkerEvent(options, created);
    records.push(created);
    const settled: ObjectiveWorkerPayload = {
      phase: 'settled',
      objectiveId: objective.id,
      sessionId: turn.sessionId,
      attempt: turn.attempt,
      generation: turn.generation,
      commit: observed.commit,
    };
    yield* appendWorkerEvent(options, settled);
    records.push(settled);

    if (turn.kind === 'blocked') {
      problem = turn.problem;
      break;
    }
    if (observed.commit !== null) {
      const disposed: ObjectiveWorkerPayload = {
        phase: 'disposed',
        objectiveId: objective.id,
        sessionId: turn.sessionId,
        attempt: turn.attempt,
        generation: turn.generation,
        commit: observed.commit,
      };
      yield* appendWorkerEvent(options, disposed);
      records.push(disposed);
      return {
        objectiveId: objective.id,
        branch,
        workspace,
        attempts: attemptsUsed(records),
        settled: true,
        commit: observed.commit,
        problem: null,
      };
    }
    problem =
      observed.problem ??
      (turn.kind === 'settled'
        ? 'the objective Coder turn settled without a new commit'
        : turn.problem);
  }

  if (lastSessionId.length > 0 && !records.some((record) => record.phase === 'disposed')) {
    const disposed: ObjectiveWorkerPayload = {
      phase: 'disposed',
      objectiveId: objective.id,
      sessionId: lastSessionId,
      attempt: lastAttempt,
      generation: lastGeneration,
      commit: lastSettledCommit(records),
    };
    yield* appendWorkerEvent(options, disposed);
    records.push(disposed);
  }

  return {
    objectiveId: objective.id,
    branch,
    workspace,
    attempts: attemptsUsed(records),
    settled: false,
    commit: null,
    problem,
  };
});

/**
 * Runs every accepted parallel objective as its own Coder worker, bounded by the
 * configured concurrency limit. Objectives that already recorded a committed
 * result are skipped so a resumed run does not duplicate work. A colliding
 * worker branch that this run does not durably own fails the orchestration
 * without moving the branch.
 */
export const runObjectiveWorkers = Effect.fn('runObjectiveWorkers')(function* (
  options: RunObjectiveWorkersOptions,
): Effect.fn.Return<
  ParallelWorkersReport,
  RunWorkspaceBlocked | RunHistoryError | ParallelWorkersTurnError,
  RunGit | RunHistoryStorage | WorkerTurnRunner | WorkerTurnRequirements
> {
  const git = yield* RunGit;
  const indexed = options.objectives.map((objective, index) => ({ objective, index }));
  const outcomes = yield* Effect.forEach(
    indexed,
    ({ objective, index }) => runOneObjective(options, git, objective, index),
    { concurrency: Math.max(1, options.maxParallelCoders) },
  );
  return {
    objectives: outcomes,
    allSettled: outcomes.every((outcome) => outcome.settled),
  };
});
