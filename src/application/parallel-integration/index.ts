import { Effect, Schema } from 'effect';

import { GitCommitId } from '../../domain/run-locations.js';
import { ReadinessGit } from '../readiness/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';

import type { PlannedObjective } from '../../domain/architect-plan.js';
import type {
  IntegrationCompletedPayload,
  IntegrationDeclaredPayload,
} from '../../domain/run-history.js';
import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';

export class ParallelIntegrationError extends Schema.TaggedError<ParallelIntegrationError>()(
  'ParallelIntegrationError',
  {
    message: Schema.String,
    runId: Schema.String,
    problem: Schema.String,
  },
) {}

export interface RecordIntegrationDeclarationOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly objectives: ReadonlyArray<PlannedObjective>;
}

/**
 * The newest settled commit for one objective. Worker-reported commits are the
 * inputs to validation, so this reads the durable worker records rather than any
 * transient report.
 */
function settledCommitFor(
  workers: ReadonlyArray<{
    readonly objectiveId: string;
    readonly phase: string;
    readonly commit: string | null;
  }>,
  objectiveId: string,
): string | null {
  for (let index = workers.length - 1; index >= 0; index -= 1) {
    const worker = workers[index];
    if (
      worker !== undefined &&
      worker.objectiveId === objectiveId &&
      worker.phase === 'settled' &&
      worker.commit !== null
    ) {
      return worker.commit;
    }
  }
  return null;
}

function integrationError(
  runId: string,
  problem: string,
  message: string,
): ParallelIntegrationError {
  return new ParallelIntegrationError({ message, runId, problem });
}

/**
 * Records the complete accepted objective/commit set and the declared
 * integration order before Lead Coder starts. The declared order is the accepted
 * plan's objective order, so worker arrival order cannot silently redefine the
 * plan. Every objective must already have a verified commit; a partial plan is
 * never declared. Repeating the call after a resume returns the existing
 * declaration instead of appending a second one.
 */
export const recordIntegrationDeclaration = Effect.fn('recordIntegrationDeclaration')(function* (
  options: RecordIntegrationDeclarationOptions,
): Effect.fn.Return<
  IntegrationDeclaredPayload,
  ParallelIntegrationError | RunHistoryError,
  RunHistoryStorage
> {
  const history = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  const existing = history.derived.integrationDeclared ?? null;
  if (existing !== null) {
    return existing;
  }
  const workers = history.derived.objectiveWorkers ?? [];
  const objectiveIds: Array<string> = [];
  const commits: Array<string> = [];
  for (const objective of options.objectives) {
    const commit = settledCommitFor(
      workers.map((worker) => ({
        objectiveId: worker.objectiveId,
        phase: worker.phase,
        commit: worker.commit,
      })),
      objective.id,
    );
    if (commit === null) {
      return yield* integrationError(
        options.runId,
        `objective "${objective.id}" has no settled worker commit`,
        `Run "${options.runId}" cannot declare integration because objective "${objective.id}" does not have a verified commit. Lead Coder waits for every objective.`,
      );
    }
    objectiveIds.push(objective.id);
    commits.push(commit);
  }
  const declaredOrder = [...objectiveIds];
  const payload: IntegrationDeclaredPayload = { objectiveIds, commits, declaredOrder };
  yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
    build: () => Effect.succeed({ type: 'integration-declared', payload } as const),
  });
  return payload;
});

export interface VerifyAggregateOptions {
  readonly runId: string;
  readonly workspace: string;
  readonly baseCommit: string;
  readonly declaration: IntegrationDeclaredPayload;
}

export interface AggregateVerification {
  readonly aggregateCommit: string;
  readonly actualOrder: ReadonlyArray<string>;
  readonly deviationReason: string | null;
}

/**
 * Verifies the Lead Coder aggregate against the accepted contributions using
 * Git, not the journal's ordering. Every accepted commit must be reachable from
 * the aggregate head. The actual contribution application order is derived from
 * the aggregate's first-parent history: each accepted commit is attributed to
 * the earliest first-parent commit that contains it, and ties fall back to the
 * declared order. A mismatch is reported as an explicit deviation reason rather
 * than silently accepted.
 */
export const verifyAggregate = Effect.fn('verifyAggregate')(function* (
  options: VerifyAggregateOptions,
): Effect.fn.Return<AggregateVerification, ParallelIntegrationError, ReadinessGit> {
  const git = yield* ReadinessGit;
  const runGit = (args: ReadonlyArray<string>) =>
    git.run(args, options.workspace).pipe(
      Effect.mapError(
        (error) =>
          new ParallelIntegrationError({
            message: `Run "${options.runId}" could not verify the parallel aggregate: ${error.message}`,
            runId: options.runId,
            problem: error.message,
          }),
      ),
    );

  const head = yield* runGit(['rev-parse', 'HEAD']);
  const aggregateCommit = head.stdout.trim();
  if (head.exitCode !== 0 || !Schema.is(GitCommitId)(aggregateCommit)) {
    return yield* integrationError(
      options.runId,
      'the aggregate head could not be resolved',
      `Run "${options.runId}" cannot verify the Lead Coder aggregate because its HEAD commit could not be resolved.`,
    );
  }
  if (aggregateCommit === options.baseCommit) {
    return yield* integrationError(
      options.runId,
      'the aggregate head is still the frozen source commit',
      `Run "${options.runId}" cannot verify the Lead Coder aggregate because no new commit was produced.`,
    );
  }

  const chain = yield* runGit([
    'rev-list',
    '--first-parent',
    '--reverse',
    `${options.baseCommit}..${aggregateCommit}`,
  ]);
  if (chain.exitCode !== 0) {
    return yield* integrationError(
      options.runId,
      'the aggregate history could not be read',
      `Run "${options.runId}" cannot verify the Lead Coder aggregate because its Git history could not be read.`,
    );
  }
  const firstParentChain = chain.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const integrationIndexes: Array<number> = [];
  for (const [index, commit] of options.declaration.commits.entries()) {
    const objectiveId = options.declaration.objectiveIds[index] ?? commit;
    const included = yield* runGit(['merge-base', '--is-ancestor', commit, aggregateCommit]);
    if (included.exitCode !== 0) {
      return yield* integrationError(
        options.runId,
        `accepted commit ${commit} for objective "${objectiveId}" is not contained by the aggregate`,
        `Run "${options.runId}" rejects the Lead Coder aggregate ${aggregateCommit} because the accepted commit ${commit} for objective "${objectiveId}" is not contained by it.`,
      );
    }
    let appliedAt = firstParentChain.length - 1;
    for (const [chainIndex, chainCommit] of firstParentChain.entries()) {
      if (chainCommit === commit) {
        appliedAt = chainIndex;
        break;
      }
      const ancestry = yield* runGit(['merge-base', '--is-ancestor', commit, chainCommit]);
      if (ancestry.exitCode === 0) {
        appliedAt = chainIndex;
        break;
      }
    }
    integrationIndexes.push(appliedAt);
  }

  const order = options.declaration.objectiveIds.map((_, index) => index);
  order.sort(
    (left, right) =>
      (integrationIndexes[left] ?? 0) - (integrationIndexes[right] ?? 0) || left - right,
  );
  const actualOrder = order.map((index) => options.declaration.objectiveIds[index] ?? '');
  const matchesDeclared =
    actualOrder.length === options.declaration.declaredOrder.length &&
    actualOrder.every(
      (objectiveId, index) => objectiveId === options.declaration.declaredOrder[index],
    );
  const deviationReason = matchesDeclared
    ? null
    : `Lead Coder applied the accepted objectives in order ${actualOrder.join(', ')} instead of the declared order ${options.declaration.declaredOrder.join(', ')}.`;
  return { aggregateCommit, actualOrder, deviationReason };
});

export interface RecordIntegrationCompletedOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly verification: AggregateVerification;
}

/**
 * Durably binds the verified aggregate and contribution application sequence to
 * the run. It re-reads the declaration so a completion can never be recorded
 * against a different accepted set, and it is idempotent across resumes.
 */
export const recordIntegrationCompleted = Effect.fn('recordIntegrationCompleted')(function* (
  options: RecordIntegrationCompletedOptions,
): Effect.fn.Return<
  IntegrationCompletedPayload,
  ParallelIntegrationError | RunHistoryError,
  RunHistoryStorage
> {
  const history = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  const existing = history.derived.integrationCompleted ?? null;
  if (existing !== null) {
    return existing;
  }
  const declaration = history.derived.integrationDeclared ?? null;
  if (declaration === null) {
    return yield* integrationError(
      options.runId,
      'integration completes without a declaration',
      `Run "${options.runId}" cannot record integration completion before the accepted objective/commit set is declared.`,
    );
  }
  const declaredObjectives = new Set(declaration.objectiveIds);
  const actualOrder = [...options.verification.actualOrder];
  if (
    actualOrder.length !== declaration.objectiveIds.length ||
    new Set(actualOrder).size !== actualOrder.length ||
    !actualOrder.every((objectiveId) => declaredObjectives.has(objectiveId))
  ) {
    return yield* integrationError(
      options.runId,
      'the verified actual order does not cover the declared objective set',
      `Run "${options.runId}" cannot record integration completion because the verified order does not match the declared objective set.`,
    );
  }
  const payload: IntegrationCompletedPayload = {
    aggregateCommit: options.verification.aggregateCommit,
    actualOrder,
    deviationReason: options.verification.deviationReason,
  };
  yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
    build: () => Effect.succeed({ type: 'integration-completed', payload } as const),
  });
  return payload;
});
