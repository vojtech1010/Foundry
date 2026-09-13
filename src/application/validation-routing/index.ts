import { Effect, Schema } from 'effect';

import { transitionWorkflow } from '../workflow-transitions/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';

import type { RunGit, RunWorkspaceBlocked } from '../git-provisioning/index.js';
import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';
import type { IllegalWorkflowTransition } from '../workflow-transitions/index.js';
import type { RunStateUnavailable } from '../run-identity/index.js';
import type { VerificationCompletedPayload } from '../../domain/run-history.js';

export class ProjectValidationRoutingError extends Schema.TaggedError<ProjectValidationRoutingError>()(
  'ProjectValidationRoutingError',
  {
    message: Schema.String,
  },
) {}

export interface RouteAfterProjectChecksOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly correctionRoundsRemaining: number;
}

export type ProjectValidationRoute =
  | { readonly route: 'testing' }
  | { readonly route: 'reviewing'; readonly testerSkipped: boolean }
  | { readonly route: 'correcting' }
  | { readonly route: 'limitation'; readonly reason: string };

function latestVerificationFor(
  reports: ReadonlyArray<VerificationCompletedPayload>,
  commit: string,
): VerificationCompletedPayload | null {
  let latest: VerificationCompletedPayload | null = null;
  for (const report of reports) {
    if (report.commit === commit) {
      latest = report;
    }
  }
  return latest;
}

export const routeAfterProjectChecks = Effect.fn('routeAfterProjectChecks')(function* (
  options: RouteAfterProjectChecksOptions,
): Effect.fn.Return<
  ProjectValidationRoute,
  | ProjectValidationRoutingError
  | IllegalWorkflowTransition
  | RunStateUnavailable
  | RunWorkspaceBlocked
  | RunHistoryError,
  RunGit | RunHistoryStorage
> {
  const history = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  const derived = history.derived;
  if (derived.state !== 'verifying') {
    return yield* new ProjectValidationRoutingError({
      message: `Run "${options.runId}" cannot route project checks from workflow state "${derived.state ?? 'none'}"; the verifying stage is required.`,
    });
  }
  const plan = derived.acceptedPlan;
  if (plan === null) {
    return yield* new ProjectValidationRoutingError({
      message: `Run "${options.runId}" has no durable accepted plan to control validation routing.`,
    });
  }
  const implementation = derived.implementation;
  const commit =
    implementation === null ? null : (implementation.commit ?? implementation.baseCommit);
  if (commit === null) {
    return yield* new ProjectValidationRoutingError({
      message: `Run "${options.runId}" has no Git-derived result commit to bind its checks.`,
    });
  }

  const report = latestVerificationFor(derived.verifications, commit);
  if (report === null) {
    return yield* new ProjectValidationRoutingError({
      message: `Run "${options.runId}" has no commit-bound verification report for ${commit}; checks must run before routing.`,
    });
  }

  if (report.result === 'failed') {
    if (options.correctionRoundsRemaining >= 1) {
      yield* transitionWorkflow({
        runDirectory: options.runDirectory,
        runId: options.runId,
        request: {
          route: 'correction-required',
          findingsBacked: true,
          correctionRoundsRemaining: options.correctionRoundsRemaining,
        },
      });
      return { route: 'correcting' };
    }
    yield* transitionWorkflow({
      runDirectory: options.runDirectory,
      runId: options.runId,
      request: {
        route: 'checks-passed-reviewing',
        checksPassed: false,
        correctionBudgetExhausted: true,
        reviewableCommit: commit,
      },
    });
    return { route: 'reviewing', testerSkipped: false };
  }

  if (!plan.runtimeValidationRequired) {
    yield* appendRunEvent({
      runDirectory: options.runDirectory,
      runId: options.runId,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'tester-skipped',
          payload: {
            reason:
              'The accepted plan does not require live application validation; Tester is explicitly skipped and no passing Tester result is manufactured.',
            verificationCommit: commit,
          },
        } as const),
    });
    yield* transitionWorkflow({
      runDirectory: options.runDirectory,
      runId: options.runId,
      request: {
        route: 'checks-passed-reviewing',
        checksPassed: true,
        correctionBudgetExhausted: false,
        reviewableCommit: commit,
      },
    });
    return { route: 'reviewing', testerSkipped: true };
  }

  const runtimeReady = derived.runtimeLifecycles.some(
    (record) => record.commit === commit && record.outcome === 'ready',
  );
  if (runtimeReady) {
    yield* transitionWorkflow({
      runDirectory: options.runDirectory,
      runId: options.runId,
      request: {
        route: 'checks-passed-testing',
        checksPassed: true,
      },
    });
    return { route: 'testing' };
  }

  const reason = `The accepted plan requires live application validation, but no prepared runtime is durably recorded for ${commit}; the required stage cannot be skipped.`;
  yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'validation-limitation',
        payload: { reason, commit },
      } as const),
  });
  return { route: 'limitation', reason };
});
