import { Effect } from 'effect';

import { decodeTesterTurnControl } from '../../domain/tester-outcomes.js';
import { bindTesterObservation } from '../evidence-invalidation/index.js';
import { appendRunEvent } from '../run-history/index.js';
import { transitionWorkflow, recordWorkflowAttempt } from '../workflow-transitions/index.js';

import type { Schema } from 'effect';

import type { EvidenceManifestEntry } from '../../domain/run-history.js';
import type { RunGit, RunWorkspaceBlocked } from '../git-provisioning/index.js';
import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';
import type { RunStateUnavailable } from '../run-identity/index.js';
import type {
  IllegalWorkflowAttempt,
  IllegalWorkflowTransition,
} from '../workflow-transitions/index.js';

export function validateTesterTurnControl(control: Schema.Json): {
  readonly ok: boolean;
  readonly problem: string;
} {
  const decoded = decodeTesterTurnControl(control);
  return decoded.ok ? { ok: true, problem: '' } : { ok: false, problem: decoded.problem };
}

export type TesterTurnDisposition =
  | { readonly kind: 'observed' }
  | { readonly kind: 'retry-required' }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'control-invalid'; readonly problem: string };

export interface HandleTesterTurnOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly control: Schema.Json;
  readonly commit: string;
  readonly testerRetriesRemaining: number;
  readonly retryReason: string;
  /**
   * Captures the settled Tester turn offers as observations of the current
   * result head. Foundry records them as an `evidence-manifest` so a hashed
   * capture stays distinguishable from a name-only claim and identical content
   * under different labels is one observation.
   */
  readonly captures?: ReadonlyArray<EvidenceManifestEntry>;
}

/**
 * Routes a settled Tester turn using only its closed control envelope. Tester
 * cannot approve or fail the implementation; `observed` settles the stage,
 * `retry_required` consumes one bounded same-commit Tester retry, and `blocked`
 * retains an explicit limitation for Reviewer. No path grants data mutation.
 */
export const handleTesterTurn = Effect.fn('handleTesterTurn')(function* (
  options: HandleTesterTurnOptions,
): Effect.fn.Return<
  TesterTurnDisposition,
  | IllegalWorkflowTransition
  | IllegalWorkflowAttempt
  | RunStateUnavailable
  | RunWorkspaceBlocked
  | RunHistoryError,
  RunGit | RunHistoryStorage
> {
  const decoded = decodeTesterTurnControl(options.control);
  if (!decoded.ok) {
    return { kind: 'control-invalid', problem: decoded.problem };
  }

  switch (decoded.control.outcome) {
    case 'observed': {
      yield* bindTesterObservation({
        runDirectory: options.runDirectory,
        runId: options.runId,
        commit: options.commit,
      });
      yield* appendRunEvent({
        runDirectory: options.runDirectory,
        runId: options.runId,
        createIfMissing: false,
        build: () =>
          Effect.succeed({
            type: 'evidence-manifest',
            payload: {
              entries: (options.captures ?? []).map((entry) => ({
                sha256: entry.sha256,
                byteLength: entry.byteLength,
                label: entry.label,
                kind: entry.kind,
                criterionIds: [...entry.criterionIds],
              })),
            },
          } as const),
      });
      yield* transitionWorkflow({
        runDirectory: options.runDirectory,
        runId: options.runId,
        request: {
          route: 'tester-settled',
          observationsSettled: true,
          runtimeLimitationRetained: false,
        },
      });
      return { kind: 'observed' };
    }
    case 'retry_required': {
      if (options.testerRetriesRemaining < 1) {
        return {
          kind: 'control-invalid',
          problem:
            'Tester requested another observation, but no Tester retry remains for this commit.',
        };
      }
      yield* recordWorkflowAttempt({
        runDirectory: options.runDirectory,
        runId: options.runId,
        attempt: {
          kind: 'retry',
          role: 'tester',
          reason: options.retryReason,
          retriesRemaining: options.testerRetriesRemaining,
        },
      });
      return { kind: 'retry-required' };
    }
    case 'blocked': {
      const reason =
        'Tester reported that it could not complete independent observation; the limitation is retained for Reviewer.';
      yield* appendRunEvent({
        runDirectory: options.runDirectory,
        runId: options.runId,
        createIfMissing: false,
        build: () =>
          Effect.succeed({
            type: 'validation-limitation',
            payload: { reason, commit: options.commit },
          } as const),
      });
      yield* transitionWorkflow({
        runDirectory: options.runDirectory,
        runId: options.runId,
        request: {
          route: 'tester-settled',
          observationsSettled: false,
          runtimeLimitationRetained: true,
        },
      });
      return { kind: 'blocked', reason };
    }
  }
});
