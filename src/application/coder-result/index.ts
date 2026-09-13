import { Effect, Result, Schema } from 'effect';

import { readVerifiedRunHistory } from '../run-history/index.js';
import { transitionWorkflow } from '../workflow-transitions/index.js';

import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';
import type {
  IllegalWorkflowTransition,
  WorkflowTransitionReport,
} from '../workflow-transitions/index.js';
import type { RunWorkspaceBlocked, RunGit } from '../git-provisioning/index.js';
import type { RunStateUnavailable } from '../run-identity/index.js';

export const CODER_TURN_OUTCOMES = ['implemented', 'no_change_candidate', 'blocked'] as const;

export type CoderTurnOutcome = (typeof CODER_TURN_OUTCOMES)[number];

export const CoderTurnControlSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  outcome: Schema.Literals(CODER_TURN_OUTCOMES),
});

export type CoderTurnControl = (typeof CoderTurnControlSchema)['Type'];

export class CoderTurnRejected extends Schema.TaggedError<CoderTurnRejected>()(
  'CoderTurnRejected',
  {
    message: Schema.String,
    runId: Schema.String,
    problem: Schema.String,
  },
) {}

export type CoderTurnDisposition =
  | { readonly outcome: 'blocked' }
  | { readonly outcome: 'no_change_candidate' }
  | { readonly outcome: 'implemented'; readonly transition: WorkflowTransitionReport };

export interface HandleCoderTurnOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly control: Schema.Json;
}

/**
 * Routes a settled Coder turn using only its closed control envelope. A blocked
 * turn is not a result: it leaves the recorded role-session, Git, and
 * provisioning evidence intact, appends no implementation acceptance, and does
 * not transition toward verification with a fabricated commit. Implemented and
 * no-change claims still pass through the Git-derived implementation route, so
 * a no-change claim stays provisional for verification and Reviewer.
 */
export const handleCoderTurn = Effect.fn('handleCoderTurn')(function* (
  options: HandleCoderTurnOptions,
): Effect.fn.Return<
  CoderTurnDisposition,
  | CoderTurnRejected
  | IllegalWorkflowTransition
  | RunStateUnavailable
  | RunWorkspaceBlocked
  | RunHistoryError,
  RunHistoryStorage | RunGit
> {
  const decoded = Schema.decodeUnknownResult(CoderTurnControlSchema, {
    onExcessProperty: 'error',
  })(options.control);
  if (Result.isFailure(decoded)) {
    return yield* new CoderTurnRejected({
      message: `The Coder control envelope for run "${options.runId}" is invalid: ${decoded.failure.message}`,
      runId: options.runId,
      problem: decoded.failure.message,
    });
  }
  const outcome = decoded.success.outcome;
  if (outcome === 'blocked') {
    const history = yield* readVerifiedRunHistory({
      runDirectory: options.runDirectory,
      runId: options.runId,
      createIfMissing: false,
    });
    if (history.derived.implementation !== null) {
      return yield* new CoderTurnRejected({
        message: `Run "${options.runId}" already has an accepted implementation and cannot report a blocked Coder turn.`,
        runId: options.runId,
        problem: 'a blocked turn after an accepted implementation',
      });
    }
    return { outcome: 'blocked' };
  }
  const transition = yield* transitionWorkflow({
    runDirectory: options.runDirectory,
    runId: options.runId,
    request: {
      route: 'implementation-ready',
      branchClean: true,
      candidateCommit: null,
      noChangeCandidateValidated: outcome === 'no_change_candidate',
    },
  });
  return outcome === 'no_change_candidate'
    ? { outcome: 'no_change_candidate' }
    : { outcome: 'implemented', transition };
});
