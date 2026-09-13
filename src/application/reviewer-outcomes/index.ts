import { Effect } from 'effect';

import type { Schema } from 'effect';

import { decodeReviewerTurnControl } from '../../domain/reviewer-outcomes.js';
import { recordReviewerCorrectionFinding } from '../findings/index.js';
import { transitionWorkflow } from '../workflow-transitions/index.js';

import type { RunGit, RunWorkspaceBlocked } from '../git-provisioning/index.js';
import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';
import type { RunStateUnavailable } from '../run-identity/index.js';
import type { IllegalWorkflowTransition } from '../workflow-transitions/index.js';

/**
 * Foundry-owned evidence facts Reviewer routing reads. They are derived from
 * verified history, never from Reviewer prose, so approval cannot be granted
 * over failed checks or missing required runtime evidence.
 */
export interface ReviewerEvidenceAssessment {
  readonly reviewableCommit: string | null;
  readonly evidenceCommitMatches: boolean;
  readonly checksPassed: boolean;
  readonly testerRequired: boolean;
  readonly runtimeEvidencePresent: boolean;
  readonly noChangeCandidate: boolean;
  readonly correctionRoundsRemaining: number;
  readonly testerRetriesRemaining: number;
  readonly publicationEligible: boolean;
}

export type ReviewerTurnDisposition =
  | { readonly kind: 'approved' }
  | { readonly kind: 'approved-no-change' }
  | { readonly kind: 'implementation-requested' }
  | { readonly kind: 'changes-requested' }
  | { readonly kind: 'retest-requested' }
  | { readonly kind: 'human-decision-required' }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'control-invalid'; readonly problem: string };

export interface HandleReviewerTurnOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly control: Schema.Json;
  readonly assessment: ReviewerEvidenceAssessment;
  readonly narrative: string;
  readonly correctionReason: string;
  readonly blockedReason: string;
}

function approvalProblem(assessment: ReviewerEvidenceAssessment): string | null {
  if (!assessment.evidenceCommitMatches) {
    return 'Reviewer approval requires current evidence bound to the approved commit.';
  }
  if (!assessment.checksPassed) {
    return 'Reviewer cannot approve after failed required deterministic checks.';
  }
  if (assessment.testerRequired && !assessment.runtimeEvidencePresent) {
    return 'Reviewer cannot approve without the required live Tester evidence.';
  }
  if (!assessment.noChangeCandidate && assessment.reviewableCommit === null) {
    return 'Reviewer approval requires a reviewable changed commit.';
  }
  return null;
}

/**
 * Routes a settled Reviewer turn using only its closed control envelope and the
 * Foundry-owned evidence assessment. Ordinary approval completes locally with
 * no publication. A genuine human-decision result is recorded as the first
 * review outcome; this slice does not open a pull request or route after it.
 *
 * A verified no-change candidate cannot complete without passed checks bound to
 * the frozen source commit, and it can never become a human-decision PR.
 * Reviewer `changes_requested` on a no-change candidate is actionable Coder work
 * that returns to `coding` without spending a correction round; an
 * inapplicable `human_decision_required` is unresolvable ambiguity and blocks.
 */
export const handleReviewerTurn = Effect.fn('handleReviewerTurn')(function* (
  options: HandleReviewerTurnOptions,
): Effect.fn.Return<
  ReviewerTurnDisposition,
  IllegalWorkflowTransition | RunStateUnavailable | RunWorkspaceBlocked | RunHistoryError,
  RunGit | RunHistoryStorage
> {
  const decoded = decodeReviewerTurnControl(options.control);
  if (!decoded.ok) {
    return { kind: 'control-invalid', problem: decoded.problem };
  }
  const assessment = options.assessment;

  switch (decoded.control.outcome) {
    case 'approved': {
      const problem = approvalProblem(assessment);
      if (problem !== null) {
        yield* transitionWorkflow({
          runDirectory: options.runDirectory,
          runId: options.runId,
          request: {
            route: 'block-run',
            recoverablePrerequisite: true,
            reason: problem,
          },
        });
        return { kind: 'blocked', reason: problem };
      }
      if (assessment.noChangeCandidate) {
        yield* transitionWorkflow({
          runDirectory: options.runDirectory,
          runId: options.runId,
          request: {
            route: 'review-approved-no-change',
            verifiedSourceApproved: true,
            implementationCommit: null,
            checksPassed: assessment.checksPassed,
            evidenceCommitMatches: assessment.evidenceCommitMatches,
          },
        });
        return { kind: 'approved-no-change' };
      }
      yield* transitionWorkflow({
        runDirectory: options.runDirectory,
        runId: options.runId,
        request: {
          route: 'review-approved',
          approvedCommit: assessment.reviewableCommit,
          evidenceCommitMatches: assessment.evidenceCommitMatches,
          checksPassed: assessment.checksPassed,
          testerRequired: assessment.testerRequired,
          runtimeEvidencePresent: assessment.runtimeEvidencePresent,
        },
      });
      return { kind: 'approved' };
    }
    case 'changes_requested': {
      if (assessment.noChangeCandidate) {
        yield* transitionWorkflow({
          runDirectory: options.runDirectory,
          runId: options.runId,
          request: {
            route: 'review-requested-implementation',
            verifiedNoChangeCandidate: true,
          },
        });
        return { kind: 'implementation-requested' };
      }
      if (assessment.correctionRoundsRemaining < 1) {
        return {
          kind: 'control-invalid',
          problem:
            'changes_requested is invalid: no correction round remains. Choose human_decision_required or blocked.',
        };
      }
      if (assessment.reviewableCommit !== null) {
        yield* recordReviewerCorrectionFinding({
          runDirectory: options.runDirectory,
          runId: options.runId,
          commit: assessment.reviewableCommit,
          narrative: options.narrative,
        });
      }
      yield* transitionWorkflow({
        runDirectory: options.runDirectory,
        runId: options.runId,
        request: {
          route: 'correction-required',
          findingsBacked: true,
          correctionRoundsRemaining: assessment.correctionRoundsRemaining,
        },
      });
      return { kind: 'changes-requested' };
    }
    case 'retest_requested': {
      if (!assessment.testerRequired) {
        return {
          kind: 'control-invalid',
          problem: 'retest_requested is invalid: the accepted plan did not require live testing.',
        };
      }
      if (assessment.testerRetriesRemaining < 1) {
        return {
          kind: 'control-invalid',
          problem: 'retest_requested is invalid: no Tester retry remains for this commit.',
        };
      }
      yield* transitionWorkflow({
        runDirectory: options.runDirectory,
        runId: options.runId,
        request: {
          route: 'retest-requested',
          reviewerRequestedRetest: true,
          sameCommit: true,
          testerRetriesRemaining: assessment.testerRetriesRemaining,
        },
      });
      return { kind: 'retest-requested' };
    }
    case 'human_decision_required': {
      if (assessment.noChangeCandidate) {
        const reason =
          'human_decision_required is invalid for a no-change candidate because there is no reviewable implementation to publish.';
        yield* transitionWorkflow({
          runDirectory: options.runDirectory,
          runId: options.runId,
          request: {
            route: 'block-run',
            recoverablePrerequisite: true,
            reason,
          },
        });
        return { kind: 'blocked', reason };
      }
      if (!assessment.publicationEligible || assessment.reviewableCommit === null) {
        yield* transitionWorkflow({
          runDirectory: options.runDirectory,
          runId: options.runId,
          request: {
            route: 'publication-unavailable',
            envelopeValid: true,
            publicationEligible: false,
          },
        });
        return {
          kind: 'blocked',
          reason:
            'A valid human-decision result was recorded, but decision publication is not configured or eligible; the run is blocked for later publication.',
        };
      }
      yield* transitionWorkflow({
        runDirectory: options.runDirectory,
        runId: options.runId,
        request: {
          route: 'human-decision-required',
          envelopeValid: true,
          reviewableChangedCommit: assessment.reviewableCommit,
          noChangeCandidate: false,
        },
      });
      return { kind: 'human-decision-required' };
    }
    case 'blocked': {
      yield* transitionWorkflow({
        runDirectory: options.runDirectory,
        runId: options.runId,
        request: {
          route: 'block-run',
          recoverablePrerequisite: true,
          reason: options.blockedReason,
        },
      });
      return { kind: 'blocked', reason: options.blockedReason };
    }
  }
});
