import { Schema } from 'effect';

import { Identifier } from './run-identity.js';

export const PRODUCT_NAME = 'Foundry';

export const WORKFLOW_ROLES = ['architect', 'coder', 'tester', 'reviewer'] as const;

export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

export const WORKFLOW_STATES = [
  'planning',
  'coding',
  'verifying',
  'testing',
  'reviewing',
  'correcting',
  'human_decision_required',
  'publishing',
  'completed',
  'completed_no_change',
  'abandoned',
  'blocked',
  'failed',
  'publish_failed',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WorkflowStateSchema = Schema.Literals(WORKFLOW_STATES);

export const ACTIVE_WORKFLOW_STATES = [
  'planning',
  'coding',
  'verifying',
  'testing',
  'reviewing',
  'correcting',
] as const satisfies ReadonlyArray<WorkflowState>;

export const DECISION_OR_PUBLICATION_WORKFLOW_STATES = [
  'human_decision_required',
  'publishing',
] as const satisfies ReadonlyArray<WorkflowState>;

export const SUCCESS_WORKFLOW_STATES = [
  'completed',
  'completed_no_change',
] as const satisfies ReadonlyArray<WorkflowState>;

export const RECOVERABLE_WORKFLOW_STATES = [
  'blocked',
  'publish_failed',
] as const satisfies ReadonlyArray<WorkflowState>;

export const TERMINAL_WORKFLOW_STATES = [
  'completed',
  'completed_no_change',
  'abandoned',
  'failed',
] as const satisfies ReadonlyArray<WorkflowState>;

export const INITIAL_WORKFLOW_STATE: WorkflowState = 'planning';

export const WORKFLOW_STATE_SCHEMA_VERSION = 1 as const;

export const WORKFLOW_STATE_FILENAME = 'workflow-state.json' as const;

export const WorkflowStateDocumentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(WORKFLOW_STATE_SCHEMA_VERSION),
  runId: Identifier,
  state: WorkflowStateSchema,
});

export type WorkflowStateDocument = (typeof WorkflowStateDocumentSchema)['Type'];

export const WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION = 2 as const;

export const WORKFLOW_ATTEMPT_KINDS = ['retry', 'repair'] as const;

export type WorkflowAttemptKind = (typeof WORKFLOW_ATTEMPT_KINDS)[number];

export const WorkflowAttemptSchema = Schema.Struct({
  sequence: Schema.Int,
  kind: Schema.Literals(WORKFLOW_ATTEMPT_KINDS),
  role: Schema.Literals(WORKFLOW_ROLES),
  state: WorkflowStateSchema,
  reason: Schema.NonEmptyString,
});

export type WorkflowAttempt = (typeof WorkflowAttemptSchema)['Type'];

export const WorkflowProgressDocumentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION),
  runId: Identifier,
  state: WorkflowStateSchema,
  checkpoint: Schema.NullOr(WorkflowStateSchema),
  attempts: Schema.Array(WorkflowAttemptSchema),
});

export type WorkflowProgressDocument = (typeof WorkflowProgressDocumentSchema)['Type'];

export const WorkflowStateRecordSchema = Schema.Union([
  WorkflowStateDocumentSchema,
  WorkflowProgressDocumentSchema,
]);

export type WorkflowStateRecord = (typeof WorkflowStateRecordSchema)['Type'];

export interface WorkflowProgressView {
  readonly state: WorkflowState;
  readonly checkpoint: WorkflowState | null;
  readonly attempts: ReadonlyArray<WorkflowAttempt>;
}

export function workflowProgressViewOf(record: WorkflowStateRecord): WorkflowProgressView {
  if (record.schemaVersion === WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION) {
    return {
      state: record.state,
      checkpoint: record.checkpoint,
      attempts: record.attempts,
    };
  }
  return { state: record.state, checkpoint: null, attempts: [] };
}

export const CLEANUP_PROGRESS_FILENAME = 'cleanup-progress.json' as const;

export const CLEANUP_PROGRESS_SCHEMA_VERSION = 1 as const;

export const CLEANUP_OUTCOMES = ['succeeded', 'warning', 'failed'] as const;

export type CleanupOutcome = (typeof CLEANUP_OUTCOMES)[number];

export const CleanupProgressDocumentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(CLEANUP_PROGRESS_SCHEMA_VERSION),
  runId: Identifier,
  outcome: Schema.Literals(CLEANUP_OUTCOMES),
  detail: Schema.String,
});

export type CleanupProgressDocument = (typeof CleanupProgressDocumentSchema)['Type'];

export function isActiveWorkflowState(state: WorkflowState): boolean {
  return ACTIVE_WORKFLOW_STATES.some((candidate) => candidate === state);
}

export function isTerminalWorkflowState(state: WorkflowState): boolean {
  return TERMINAL_WORKFLOW_STATES.some((candidate) => candidate === state);
}

export const WORKFLOW_TRANSITION_ROUTE_KINDS = [
  'run-created',
  'plan-accepted',
  'plan-no-change',
  'implementation-ready',
  'checks-passed-testing',
  'checks-passed-reviewing',
  'correction-required',
  'tester-settled',
  'retest-requested',
  'review-approved',
  'review-approved-no-change',
  'human-decision-required',
  'publication-unavailable',
  'draft-pr-reconciled',
  'publication-unresolved',
  'human-accepted',
  'human-corrected',
  'abandon-run',
  'block-run',
  'fail-run',
  'resume',
] as const;

export type WorkflowTransitionRouteKind = (typeof WORKFLOW_TRANSITION_ROUTE_KINDS)[number];

export interface ProvisioningFacts {
  readonly source: boolean;
  readonly lease: boolean;
  readonly storage: boolean;
  readonly worktree: boolean;
}

export type WorkflowTransitionRequest =
  | { readonly route: 'run-created'; readonly provisioning: ProvisioningFacts }
  | { readonly route: 'plan-accepted'; readonly planRequiresImplementation: boolean }
  | { readonly route: 'plan-no-change'; readonly noChangeCandidateAccepted: boolean }
  | {
      readonly route: 'implementation-ready';
      readonly branchClean: boolean;
      readonly candidateCommit: string | null;
      readonly noChangeCandidateValidated: boolean;
    }
  | {
      readonly route: 'checks-passed-testing';
      readonly checksPassed: boolean;
      readonly runtimeValidationRequired: boolean;
    }
  | {
      readonly route: 'checks-passed-reviewing';
      readonly checksPassed: boolean;
      readonly testerRequired: boolean;
      readonly correctionBudgetExhausted: boolean;
      readonly reviewableCommit: string | null;
    }
  | {
      readonly route: 'correction-required';
      readonly findingsBacked: boolean;
      readonly correctionRoundsRemaining: number;
    }
  | {
      readonly route: 'tester-settled';
      readonly observationsSettled: boolean;
      readonly runtimeLimitationRetained: boolean;
    }
  | {
      readonly route: 'retest-requested';
      readonly reviewerRequestedRetest: boolean;
      readonly sameCommit: boolean;
      readonly testerRetriesRemaining: number;
    }
  | {
      readonly route: 'review-approved';
      readonly approvedCommit: string | null;
      readonly evidenceCommitMatches: boolean;
      readonly checksPassed: boolean;
      readonly testerRequired: boolean;
      readonly runtimeEvidencePresent: boolean;
    }
  | {
      readonly route: 'review-approved-no-change';
      readonly verifiedSourceApproved: boolean;
      readonly implementationCommit: string | null;
    }
  | {
      readonly route: 'human-decision-required';
      readonly envelopeValid: boolean;
      readonly reviewableChangedCommit: string | null;
      readonly noChangeCandidate: boolean;
    }
  | {
      readonly route: 'publication-unavailable';
      readonly envelopeValid: boolean;
      readonly publicationEligible: boolean;
    }
  | { readonly route: 'draft-pr-reconciled'; readonly draftPrUrl: string | null }
  | { readonly route: 'publication-unresolved'; readonly cannotReconcileSafely: boolean }
  | { readonly route: 'human-accepted'; readonly authenticated: boolean }
  | { readonly route: 'human-corrected'; readonly authenticated: boolean }
  | { readonly route: 'abandon-run'; readonly explicitRequest: boolean; readonly reason: string }
  | {
      readonly route: 'block-run';
      readonly recoverablePrerequisite: boolean;
      readonly reason: string;
    }
  | { readonly route: 'fail-run'; readonly validatedFailure: boolean; readonly reason: string }
  | { readonly route: 'resume'; readonly prerequisiteValid: boolean };

export type WorkflowAttemptRequest =
  | {
      readonly kind: 'retry';
      readonly role: WorkflowRole;
      readonly reason: string;
      readonly retriesRemaining: number;
    }
  | {
      readonly kind: 'repair';
      readonly role: WorkflowRole;
      readonly reason: string;
      readonly repairsRemaining: number;
    };

export type WorkflowRouteScope =
  | 'creation'
  | 'nonterminal'
  | 'active'
  | ReadonlyArray<WorkflowState>;

export interface WorkflowTransitionRouteDefinition {
  readonly from: WorkflowRouteScope;
  readonly to: WorkflowState | 'recorded-checkpoint';
  readonly fact: string;
}

export const WORKFLOW_TRANSITION_ROUTES: Readonly<
  Record<WorkflowTransitionRouteKind, WorkflowTransitionRouteDefinition>
> = {
  'run-created': {
    from: 'creation',
    to: 'planning',
    fact: 'source, lease, storage, and worktree provisioning checkpoints are durable',
  },
  'plan-accepted': {
    from: ['planning'],
    to: 'coding',
    fact: 'accepted plan requires implementation',
  },
  'plan-no-change': {
    from: ['planning'],
    to: 'verifying',
    fact: 'accepted no-change candidate',
  },
  'implementation-ready': {
    from: ['coding', 'correcting'],
    to: 'verifying',
    fact: 'clean assigned branch with a new Git-derived candidate commit or a validated no-change candidate',
  },
  'checks-passed-testing': {
    from: ['verifying'],
    to: 'testing',
    fact: 'checks passed and the accepted plan requires runtime validation',
  },
  'checks-passed-reviewing': {
    from: ['verifying'],
    to: 'reviewing',
    fact: 'checks passed without a required Tester stage, or an exhausted correction budget with a reviewable commit',
  },
  'correction-required': {
    from: ['verifying', 'testing', 'reviewing'],
    to: 'correcting',
    fact: 'evidence-backed Coder work remains and a correction round is available',
  },
  'tester-settled': {
    from: ['testing'],
    to: 'reviewing',
    fact: 'settled Tester observations or a retained runtime limitation',
  },
  'retest-requested': {
    from: ['reviewing'],
    to: 'testing',
    fact: 'Reviewer requested another observation against the same commit and a Tester retry remains',
  },
  'review-approved': {
    from: ['reviewing'],
    to: 'completed',
    fact: 'Reviewer approved the exact changed commit and current evidence',
  },
  'review-approved-no-change': {
    from: ['reviewing'],
    to: 'completed_no_change',
    fact: 'Reviewer approved the verified source as already satisfying the request',
  },
  'human-decision-required': {
    from: ['reviewing'],
    to: 'publishing',
    fact: 'a valid human_decision_required envelope and a reviewable changed commit',
  },
  'publication-unavailable': {
    from: ['reviewing'],
    to: 'blocked',
    fact: 'a valid human-decision result while publication is not configured or eligible',
  },
  'draft-pr-reconciled': {
    from: ['publishing'],
    to: 'human_decision_required',
    fact: 'an exact draft PR URL durably reconciled',
  },
  'publication-unresolved': {
    from: ['publishing'],
    to: 'publish_failed',
    fact: 'publication that cannot yet be reconciled safely',
  },
  'human-accepted': {
    from: ['human_decision_required'],
    to: 'completed',
    fact: 'an authenticated accept option',
  },
  'human-corrected': {
    from: ['human_decision_required'],
    to: 'correcting',
    fact: 'an authenticated correct option',
  },
  'abandon-run': {
    from: 'nonterminal',
    to: 'abandoned',
    fact: 'an explicit abandonment request and a recorded reason',
  },
  'block-run': {
    from: 'active',
    to: 'blocked',
    fact: 'a recoverable prerequisite or integrity condition and a recorded reason',
  },
  'fail-run': {
    from: 'active',
    to: 'failed',
    fact: 'a validated non-recoverable failure or exhausted budget and a recorded reason',
  },
  resume: {
    from: ['blocked', 'publish_failed'],
    to: 'recorded-checkpoint',
    fact: 'a valid prerequisite and a recorded resume checkpoint',
  },
};

export interface WorkflowTransitionContext {
  readonly state: WorkflowState | null;
  readonly checkpoint: WorkflowState | null;
}

export type WorkflowTransitionEvaluation =
  | {
      readonly ok: true;
      readonly to: WorkflowState;
      readonly checkpoint: WorkflowState | null;
    }
  | {
      readonly ok: false;
      readonly to: WorkflowState | null;
      readonly reason: string;
      readonly missingFact: string | null;
    };

function hasText(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}

export function allowsWorkflowRouteFrom(
  scope: WorkflowRouteScope,
  state: WorkflowState | null,
): boolean {
  if (scope === 'creation') {
    return state === null;
  }
  if (state === null) {
    return false;
  }
  if (scope === 'nonterminal') {
    return !isTerminalWorkflowState(state);
  }
  if (scope === 'active') {
    return isActiveWorkflowState(state);
  }
  return scope.some((candidate) => candidate === state);
}

function nominalTargetOf(route: WorkflowTransitionRouteKind): WorkflowState | null {
  const target = WORKFLOW_TRANSITION_ROUTES[route].to;
  return target === 'recorded-checkpoint' ? null : target;
}

function allowed(
  to: WorkflowState,
  checkpoint: WorkflowState | null,
): WorkflowTransitionEvaluation {
  return { ok: true, to, checkpoint };
}

function refused(
  to: WorkflowState | null,
  missingFact: string | null,
  reason: string,
): WorkflowTransitionEvaluation {
  return { ok: false, to, reason, missingFact };
}

function checkTransitionFacts(
  context: WorkflowTransitionContext,
  request: WorkflowTransitionRequest,
): WorkflowTransitionEvaluation {
  switch (request.route) {
    case 'run-created': {
      const checkpoints: ReadonlyArray<readonly [boolean, string]> = [
        [request.provisioning.source, 'source'],
        [request.provisioning.lease, 'lease'],
        [request.provisioning.storage, 'storage'],
        [request.provisioning.worktree, 'worktree'],
      ];
      for (const [durable, checkpoint] of checkpoints) {
        if (!durable) {
          return refused(
            'planning',
            `durable ${checkpoint} provisioning checkpoint`,
            `Run creation to planning requires durable source, lease, storage, and worktree provisioning checkpoints; the ${checkpoint} checkpoint is not durable.`,
          );
        }
      }
      return allowed('planning', null);
    }
    case 'plan-accepted': {
      if (!request.planRequiresImplementation) {
        return refused(
          'coding',
          'accepted plan requires implementation',
          'The "plan-accepted" route to coding requires an accepted plan that requires implementation.',
        );
      }
      return allowed('coding', null);
    }
    case 'plan-no-change': {
      if (!request.noChangeCandidateAccepted) {
        return refused(
          'verifying',
          'accepted no-change candidate',
          'The "plan-no-change" route to verifying requires an accepted no-change candidate.',
        );
      }
      return allowed('verifying', null);
    }
    case 'implementation-ready': {
      if (!request.branchClean) {
        return refused(
          'verifying',
          'clean assigned branch',
          'The "implementation-ready" route to verifying requires a clean assigned branch.',
        );
      }
      if (!hasText(request.candidateCommit) && !request.noChangeCandidateValidated) {
        return refused(
          'verifying',
          'Git-derived candidate commit or validated no-change candidate',
          'The "implementation-ready" route to verifying requires a new Git-derived candidate commit or a validated no-change candidate.',
        );
      }
      return allowed('verifying', null);
    }
    case 'checks-passed-testing': {
      if (!request.checksPassed) {
        return refused(
          'testing',
          'passed commit-bound checks',
          'The "checks-passed-testing" route requires passed commit-bound checks.',
        );
      }
      if (!request.runtimeValidationRequired) {
        return refused(
          'testing',
          'accepted plan requires runtime validation',
          'The "checks-passed-testing" route requires the accepted plan to require runtime validation.',
        );
      }
      return allowed('testing', null);
    }
    case 'checks-passed-reviewing': {
      if (request.checksPassed && !request.testerRequired) {
        return allowed('reviewing', null);
      }
      if (request.correctionBudgetExhausted && hasText(request.reviewableCommit)) {
        return allowed('reviewing', null);
      }
      if (!request.checksPassed) {
        return refused(
          'reviewing',
          'passed commit-bound checks or an exhausted correction budget with a reviewable commit',
          'The "checks-passed-reviewing" route requires passed checks unless the correction budget is exhausted with a reviewable commit.',
        );
      }
      if (!hasText(request.reviewableCommit)) {
        return refused(
          'reviewing',
          'reviewable commit',
          'The "checks-passed-reviewing" route with an exhausted correction budget requires a reviewable commit.',
        );
      }
      return refused(
        'reviewing',
        'exhausted correction budget or no required Tester stage',
        'The "checks-passed-reviewing" route requires no required Tester stage or an exhausted correction budget with a reviewable commit.',
      );
    }
    case 'correction-required': {
      if (!request.findingsBacked) {
        return refused(
          'correcting',
          'evidence-backed Coder findings',
          'The "correction-required" route requires evidence-backed Coder work that remains.',
        );
      }
      if (request.correctionRoundsRemaining < 1) {
        return refused(
          'correcting',
          'available correction round',
          'No correction round remains; the run must be reviewed, escalated, blocked, or failed instead.',
        );
      }
      return allowed('correcting', null);
    }
    case 'tester-settled': {
      if (!request.observationsSettled && !request.runtimeLimitationRetained) {
        return refused(
          'reviewing',
          'settled Tester observations or a retained runtime limitation',
          'The "tester-settled" route requires settled Tester observations or a retained runtime limitation.',
        );
      }
      return allowed('reviewing', null);
    }
    case 'retest-requested': {
      if (!request.reviewerRequestedRetest) {
        return refused(
          'testing',
          'Reviewer retest request',
          'The "retest-requested" route requires a Reviewer request for another observation.',
        );
      }
      if (!request.sameCommit) {
        return refused(
          'testing',
          'same commit as the reviewed result',
          'The "retest-requested" route must observe the same reviewed commit.',
        );
      }
      if (request.testerRetriesRemaining < 1) {
        return refused(
          'testing',
          'available Tester retry',
          'No Tester retry remains; the limitation must return to Reviewer.',
        );
      }
      return allowed('testing', null);
    }
    case 'review-approved': {
      if (!hasText(request.approvedCommit)) {
        return refused(
          'completed',
          'exact changed commit',
          'Reviewer approval of a changed result requires the exact approved commit.',
        );
      }
      if (!request.evidenceCommitMatches) {
        return refused(
          'completed',
          'current commit-bound evidence',
          'Reviewer approval requires current evidence bound to the approved commit.',
        );
      }
      if (!request.checksPassed) {
        return refused(
          'completed',
          'passed required checks',
          'Reviewer approval cannot complete after failed required checks.',
        );
      }
      if (request.testerRequired && !request.runtimeEvidencePresent) {
        return refused(
          'completed',
          'required runtime evidence',
          'Reviewer approval cannot complete without the required runtime evidence.',
        );
      }
      return allowed('completed', null);
    }
    case 'review-approved-no-change': {
      if (!request.verifiedSourceApproved) {
        return refused(
          'completed_no_change',
          'verified source that already satisfies the request',
          'The "review-approved-no-change" route requires approved, verified source that already satisfies the request.',
        );
      }
      if (hasText(request.implementationCommit)) {
        return refused(
          'completed_no_change',
          'verified source without an implementation commit',
          'A changed result cannot complete as a no-change run.',
        );
      }
      return allowed('completed_no_change', null);
    }
    case 'human-decision-required': {
      if (!request.envelopeValid) {
        return refused(
          'publishing',
          'valid human_decision_required envelope',
          'The "human-decision-required" route requires a valid human_decision_required envelope.',
        );
      }
      if (request.noChangeCandidate) {
        return refused(
          'publishing',
          'changed reviewable commit',
          'A no-change candidate cannot become a human-decision pull request.',
        );
      }
      if (!hasText(request.reviewableChangedCommit)) {
        return refused(
          'publishing',
          'reviewable changed commit',
          'The "human-decision-required" route requires a reviewable changed commit.',
        );
      }
      return allowed('publishing', null);
    }
    case 'publication-unavailable': {
      if (!request.envelopeValid) {
        return refused(
          'blocked',
          'valid human-decision result',
          'The "publication-unavailable" route requires a valid human-decision result.',
        );
      }
      if (request.publicationEligible) {
        return refused(
          'blocked',
          'publication that is not configured or eligible',
          'The "publication-unavailable" route requires publication to be not configured or eligible.',
        );
      }
      return allowed('blocked', context.state);
    }
    case 'draft-pr-reconciled': {
      if (!hasText(request.draftPrUrl)) {
        return refused(
          'human_decision_required',
          'exact draft PR URL durably reconciled',
          'The "draft-pr-reconciled" route requires the exact draft PR URL to be durably reconciled.',
        );
      }
      return allowed('human_decision_required', null);
    }
    case 'publication-unresolved': {
      if (!request.cannotReconcileSafely) {
        return refused(
          'publish_failed',
          'publication that cannot yet be reconciled safely',
          'The "publication-unresolved" route requires publication that cannot yet be reconciled safely.',
        );
      }
      return allowed('publish_failed', context.state);
    }
    case 'human-accepted': {
      if (!request.authenticated) {
        return refused(
          'completed',
          'authenticated accept option',
          'Completing a human-decision run requires the authenticated accept option.',
        );
      }
      return allowed('completed', null);
    }
    case 'human-corrected': {
      if (!request.authenticated) {
        return refused(
          'correcting',
          'authenticated correct option',
          'Correcting a human-decision run requires the authenticated correct option.',
        );
      }
      return allowed('correcting', null);
    }
    case 'abandon-run': {
      if (!request.explicitRequest) {
        return refused(
          'abandoned',
          'explicit abandonment request',
          'Abandoning a run requires an explicit abandonment request.',
        );
      }
      if (request.reason.trim().length === 0) {
        return refused(
          'abandoned',
          'recorded abandonment reason',
          'Abandoning a run requires a recorded reason.',
        );
      }
      return allowed('abandoned', null);
    }
    case 'block-run': {
      if (!request.recoverablePrerequisite) {
        return refused(
          'blocked',
          'recoverable prerequisite or integrity condition',
          'Blocking a run requires a recoverable prerequisite or integrity condition.',
        );
      }
      if (request.reason.trim().length === 0) {
        return refused(
          'blocked',
          'recorded blocking reason',
          'Blocking a run requires a recorded reason.',
        );
      }
      return allowed('blocked', context.state);
    }
    case 'fail-run': {
      if (!request.validatedFailure) {
        return refused(
          'failed',
          'validated non-recoverable failure or exhausted budget',
          'Failing a run requires a validated non-recoverable failure or exhausted budget.',
        );
      }
      if (request.reason.trim().length === 0) {
        return refused(
          'failed',
          'recorded failure reason',
          'Failing a run requires a recorded reason.',
        );
      }
      return allowed('failed', null);
    }
    case 'resume': {
      if (context.checkpoint === null) {
        return refused(
          null,
          'recorded resume checkpoint',
          'The run has no recorded resume checkpoint; resume cannot guess a destination.',
        );
      }
      if (context.state === 'blocked' && !isActiveWorkflowState(context.checkpoint)) {
        return refused(
          context.checkpoint,
          'active resume checkpoint',
          `The recorded checkpoint "${context.checkpoint}" is not an active state that resume may re-enter.`,
        );
      }
      if (context.state === 'publish_failed' && context.checkpoint !== 'publishing') {
        return refused(
          context.checkpoint,
          'publishing resume checkpoint',
          `The recorded checkpoint "${context.checkpoint}" cannot resume publication.`,
        );
      }
      if (!request.prerequisiteValid) {
        return refused(
          context.checkpoint,
          'valid resume prerequisite',
          'Resume requires the recorded prerequisite to be valid.',
        );
      }
      return allowed(context.checkpoint, null);
    }
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

export function evaluateWorkflowTransition(
  context: WorkflowTransitionContext,
  request: WorkflowTransitionRequest,
): WorkflowTransitionEvaluation {
  const definition = WORKFLOW_TRANSITION_ROUTES[request.route];
  const nominalTarget = nominalTargetOf(request.route);

  if (context.state !== null && isTerminalWorkflowState(context.state)) {
    return refused(
      nominalTarget,
      null,
      `Workflow state "${context.state}" is terminal; no further workflow transition is allowed.`,
    );
  }
  if (!allowsWorkflowRouteFrom(definition.from, context.state)) {
    const from = context.state ?? 'a run with no recorded state';
    return refused(
      nominalTarget,
      null,
      `The "${request.route}" route is not allowed from ${from}.`,
    );
  }
  return checkTransitionFacts(context, request);
}
