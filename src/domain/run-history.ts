import { createHash } from 'node:crypto';
import { Schema } from 'effect';

import {
  DecisionId,
  DecisionOpenedPayloadSchema,
  DecisionOptionId,
  PUBLICATION_CHECKPOINT_STAGES,
  PublicationCheckpointPayloadSchema,
} from './decision-publication.js';
import { FindingRecordSchema } from './findings.js';
import { REVIEWER_DECISION_ACTIONS } from './reviewer-outcomes.js';
import { GuidanceSnapshotFileSchema } from './guidance.js';
import {
  ROLE_HOST_DISPOSITIONS,
  ROLE_HOST_ROLES,
  ROLE_HOST_STATUSES,
  ROLE_HOST_SUBMISSIONS,
  RoleHostControlSchema,
  RoleHostNarrativeSchema,
  RoleHostRuntimeIdentitySchema,
} from './role-host.js';
import { ProjectVerificationReportSchema } from './project-verification.js';
import { RuntimeLifecycleRecordSchema } from './project-runtime.js';
import { GitCommitId } from './run-locations.js';
import { Identifier, Sha256Hex } from './run-identity.js';
import {
  CLEANUP_OUTCOMES,
  WORKFLOW_ATTEMPT_KINDS,
  WORKFLOW_ROLES,
  WORKFLOW_TRANSITION_ROUTE_KINDS,
  WORKFLOW_TRANSITION_ROUTES,
  WorkflowStateSchema,
  allowsWorkflowRouteFrom,
  isActiveWorkflowState,
  isTerminalWorkflowState,
} from './workflow.js';

import type {
  DecisionOpenedPayload,
  PublicationCheckpointPayload,
  PublicationCheckpointStage,
} from './decision-publication.js';
import type { FindingRecord } from './findings.js';
import type { ProjectVerificationReport, VerificationExecution } from './project-verification.js';
import type { RuntimeLifecycleRecord } from './project-runtime.js';
import type {
  RoleHostControl,
  RoleHostObservation,
  RoleHostSessionState,
  RoleHostSubmission,
} from './role-host.js';
import type { WorkflowAttempt, WorkflowState } from './workflow.js';

export const RUN_HISTORY_SCHEMA_VERSION = 1 as const;

export const RUN_HISTORY_WITNESS_SCHEMA_VERSION = 1 as const;

export const RUN_HISTORY_FILENAME = 'events.jsonl' as const;

export const RUN_HISTORY_WITNESS_FILENAME = 'events.witness.json' as const;

export const RUN_HISTORY_LOCK_FILENAME = 'events.jsonl.lock' as const;

export const RUN_HISTORY_EVENT_TYPES = [
  'run-created',
  'source-frozen',
  'guidance-frozen',
  'worktree-ready',
  'workflow-transition',
  'workflow-attempt',
  'cleanup-progress',
  'role-session-created',
  'role-session-submission-requested',
  'role-session-submission-started',
  'role-session-observed',
  'role-session-stopped',
  'role-control-rejected',
  'role-control-repair-requested',
  'role-control-repair-started',
  'plan-accepted',
  'finding-recorded',
  'role-permission-violation',
  'implementation-accepted',
  'verification-completed',
  'tester-skipped',
  'validation-limitation',
  'runtime-lifecycle',
  'decision-opened',
  'publication-checkpoint',
  'objective-worker',
  'evidence-invalidated',
  'evidence-bound',
  'decision-applied',
  'publication-reconciled',
  'integration-declared',
  'integration-completed',
  'evidence-manifest',
  'recovery-recorded',
  'result-pr-checkpoint',
  'result-pr-recorded',
  'result-merge-recorded',
  'abandonment-note',
] as const;

export type RunHistoryEventType = (typeof RUN_HISTORY_EVENT_TYPES)[number];

const EVENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const RunEventId = Schema.String.check(Schema.isPattern(EVENT_ID_PATTERN));

export const UtcInstant = Schema.String.check(Schema.isPattern(UTC_INSTANT_PATTERN));

export const RunCreatedPayloadSchema = Schema.Struct({
  taskId: Identifier,
});

export type RunCreatedPayload = (typeof RunCreatedPayloadSchema)['Type'];

export const RunRepositoryIdentitySchema = Schema.Struct({
  repositoryRoot: Schema.NonEmptyString,
  gitDirectory: Schema.NonEmptyString,
  remoteUrl: Schema.NonEmptyString,
});

export type RunRepositoryIdentity = (typeof RunRepositoryIdentitySchema)['Type'];

export const SourceFrozenPayloadSchema = Schema.Struct({
  repository: RunRepositoryIdentitySchema,
  sourceRemote: Schema.NonEmptyString,
  sourceBranch: Schema.NonEmptyString,
  sourceCommit: GitCommitId,
  taskBranch: Schema.NonEmptyString,
  workspace: Schema.NonEmptyString,
  expectedHead: GitCommitId,
});

export type SourceFrozenPayload = (typeof SourceFrozenPayloadSchema)['Type'];

export const WorktreeReadyPayloadSchema = Schema.Struct({
  taskBranch: Schema.NonEmptyString,
  workspace: Schema.NonEmptyString,
  headCommit: GitCommitId,
  baseCommit: GitCommitId,
});

export type WorktreeReadyPayload = (typeof WorktreeReadyPayloadSchema)['Type'];

export const GuidanceFrozenPayloadSchema = Schema.Struct({
  sourceCommit: GitCommitId,
  manifestPath: Schema.NonEmptyString,
  aggregateHash: Sha256Hex,
  files: Schema.Array(GuidanceSnapshotFileSchema),
});

export type GuidanceFrozenPayload = (typeof GuidanceFrozenPayloadSchema)['Type'];

export const WorkflowTransitionPayloadSchema = Schema.Struct({
  route: Schema.Literals(WORKFLOW_TRANSITION_ROUTE_KINDS),
  from: Schema.NullOr(WorkflowStateSchema),
  to: WorkflowStateSchema,
  checkpoint: Schema.NullOr(WorkflowStateSchema),
});

export type WorkflowTransitionPayload = (typeof WorkflowTransitionPayloadSchema)['Type'];

export const WorkflowAttemptPayloadSchema = Schema.Struct({
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  kind: Schema.Literals(WORKFLOW_ATTEMPT_KINDS),
  role: Schema.Literals(WORKFLOW_ROLES),
  state: WorkflowStateSchema,
  reason: Schema.NonEmptyString,
});

export type WorkflowAttemptPayload = (typeof WorkflowAttemptPayloadSchema)['Type'];

export const CleanupProgressPayloadSchema = Schema.Struct({
  outcome: Schema.Literals(CLEANUP_OUTCOMES),
  detail: Schema.String,
});

export type CleanupProgressPayload = (typeof CleanupProgressPayloadSchema)['Type'];

const PositiveCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const RoleSessionCreatedPayloadSchema = Schema.Struct({
  role: Schema.Literals(ROLE_HOST_ROLES),
  attempt: PositiveCount,
  generation: PositiveCount,
  sessionId: Schema.NonEmptyString,
  ownershipToken: Schema.NonEmptyString,
  sequence: Schema.Natural,
  runtimeIdentity: RoleHostRuntimeIdentitySchema,
  workingDirectory: Schema.NullOr(Schema.NonEmptyString),
});

export type RoleSessionCreatedPayload = (typeof RoleSessionCreatedPayloadSchema)['Type'];

export const ROLE_SESSION_SUBMISSION_KINDS = ['initial', 'repair'] as const;

export type RoleSessionSubmissionKind = (typeof ROLE_SESSION_SUBMISSION_KINDS)[number];

/**
 * Durable context for a same-session control repair. The rejected narrative
 * and control hashes prove the repair prompt could not have changed the
 * original Markdown, and the validation error explains why a repair was
 * required. The repair prompt hash travels in the submission's `promptHash`.
 */
export const RoleSessionRepairContextSchema = Schema.Struct({
  rejectedSequence: Schema.Natural,
  rejectedControl: Schema.NullOr(RoleHostControlSchema),
  rejectedNarrativeHash: Sha256Hex,
  rejectedControlHash: Schema.NullOr(Sha256Hex),
  validationError: Schema.NonEmptyString,
});

export type RoleSessionRepairContext = (typeof RoleSessionRepairContextSchema)['Type'];

export const RoleSessionSubmissionRequestedPayloadSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: PositiveCount,
  kind: Schema.optional(Schema.Literals(ROLE_SESSION_SUBMISSION_KINDS)),
  idempotencyKey: Schema.NonEmptyString,
  promptHash: Sha256Hex,
  baselineSequence: Schema.Natural,
  repair: Schema.optional(Schema.NullOr(RoleSessionRepairContextSchema)),
});

export type RoleSessionSubmissionRequestedPayload =
  (typeof RoleSessionSubmissionRequestedPayloadSchema)['Type'];

export const RoleSessionSubmissionStartedPayloadSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: PositiveCount,
  idempotencyKey: Schema.NonEmptyString,
  submission: Schema.Literals(ROLE_HOST_SUBMISSIONS),
});

export type RoleSessionSubmissionStartedPayload =
  (typeof RoleSessionSubmissionStartedPayloadSchema)['Type'];

export const RoleSessionObservedPayloadSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: PositiveCount,
  status: Schema.Literals(ROLE_HOST_STATUSES),
  sequence: Schema.Natural,
  eventCount: Schema.Natural,
  narrative: Schema.NullOr(RoleHostNarrativeSchema),
  control: Schema.NullOr(RoleHostControlSchema),
});

export type RoleSessionObservedPayload = (typeof RoleSessionObservedPayloadSchema)['Type'];

export const RoleSessionStoppedPayloadSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: PositiveCount,
  disposition: Schema.Literals(ROLE_HOST_DISPOSITIONS),
});

export type RoleSessionStoppedPayload = (typeof RoleSessionStoppedPayloadSchema)['Type'];

export const RoleControlRejectedPayloadSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: PositiveCount,
  sequence: Schema.Natural,
  narrativeHash: Sha256Hex,
  controlHash: Sha256Hex,
  problem: Schema.NonEmptyString,
});

export type RoleControlRejectedPayload = (typeof RoleControlRejectedPayloadSchema)['Type'];

export const RoleControlRepairRequestedPayloadSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: PositiveCount,
  idempotencyKey: Schema.NonEmptyString,
  promptHash: Sha256Hex,
  baselineSequence: Schema.Natural,
  problem: Schema.NonEmptyString,
});

export type RoleControlRepairRequestedPayload =
  (typeof RoleControlRepairRequestedPayloadSchema)['Type'];

export const RoleControlRepairStartedPayloadSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: PositiveCount,
  idempotencyKey: Schema.NonEmptyString,
  submission: Schema.Literals(ROLE_HOST_SUBMISSIONS),
});

export type RoleControlRepairStartedPayload =
  (typeof RoleControlRepairStartedPayloadSchema)['Type'];

/**
 * Durable, resumable evidence of one same-session control repair attempt. A
 * record begins at rejection, gains its repair intent, then its submission, and
 * is completed by the repair observation. Retry, repair, and correction budgets
 * stay separate because this record never creates a new role attempt or commit.
 */
export interface RoleControlRepairRecord {
  readonly sessionId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly narrativeHash: string;
  readonly controlHash: string;
  readonly problem: string;
  readonly idempotencyKey: string;
  readonly promptHash: string;
  readonly baselineSequence: number;
  readonly submission: RoleHostSubmission | null;
  readonly observation: RoleHostObservation | null;
}

export const PlanAcceptedCriterionSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
});

export type PlanAcceptedCriterion = (typeof PlanAcceptedCriterionSchema)['Type'];

export const PlanAcceptedObjectiveSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  affectedPaths: Schema.Array(Schema.NonEmptyString),
  criterionIds: Schema.Array(Schema.NonEmptyString),
});

export type PlanAcceptedObjective = (typeof PlanAcceptedObjectiveSchema)['Type'];

export const PlanAcceptedExecutionSchema = Schema.Struct({
  mode: Schema.Literals(['sequential', 'parallel']),
  objectives: Schema.Array(PlanAcceptedObjectiveSchema),
});

export type PlanAcceptedExecution = (typeof PlanAcceptedExecutionSchema)['Type'];

export const PlanAcceptedPayloadSchema = Schema.Struct({
  outcome: Schema.Literals(['plan_ready', 'no_change_candidate']),
  criteria: Schema.Array(PlanAcceptedCriterionSchema),
  runtimeValidationRequired: Schema.Boolean,
  execution: PlanAcceptedExecutionSchema,
});

export type PlanAcceptedPayload = (typeof PlanAcceptedPayloadSchema)['Type'];

export const FindingRecordedPayloadSchema = FindingRecordSchema;

export type FindingRecordedPayload = FindingRecord;

export const ROLE_PERMISSION_VIOLATION_KINDS = [
  'project-mutation',
  'run-resource-mutation',
  'missing-enforcement',
] as const;

export type RolePermissionViolationKind = (typeof ROLE_PERMISSION_VIOLATION_KINDS)[number];

export const RolePermissionViolationPayloadSchema = Schema.Struct({
  role: Schema.Literals(ROLE_HOST_ROLES),
  attempt: PositiveCount,
  kind: Schema.Literals(ROLE_PERMISSION_VIOLATION_KINDS),
  detail: Schema.NonEmptyString,
});

export type RolePermissionViolationPayload = (typeof RolePermissionViolationPayloadSchema)['Type'];

export const ImplementationAcceptedPayloadSchema = Schema.Struct({
  taskBranch: Schema.NonEmptyString,
  baseCommit: Schema.NonEmptyString,
  commit: Schema.NullOr(Schema.NonEmptyString),
  changedFiles: Schema.Array(Schema.NonEmptyString),
  noChangeCandidate: Schema.Boolean,
});

export type ImplementationAcceptedPayload = (typeof ImplementationAcceptedPayloadSchema)['Type'];

export const VerificationCompletedPayloadSchema = ProjectVerificationReportSchema;

export type VerificationCompletedPayload = ProjectVerificationReport;

export const TesterSkippedPayloadSchema = Schema.Struct({
  reason: Schema.NonEmptyString,
  verificationCommit: Schema.NonEmptyString,
});

export type TesterSkippedPayload = (typeof TesterSkippedPayloadSchema)['Type'];

export const ValidationLimitationPayloadSchema = Schema.Struct({
  reason: Schema.NonEmptyString,
  commit: Schema.NonEmptyString,
});

export type ValidationLimitationPayload = (typeof ValidationLimitationPayloadSchema)['Type'];

export const RuntimeLifecyclePayloadSchema = RuntimeLifecycleRecordSchema;

export type RuntimeLifecyclePayload = RuntimeLifecycleRecord;

export const OBJECTIVE_WORKER_PHASES = ['created', 'settled', 'disposed'] as const;

export type ObjectiveWorkerPhase = (typeof OBJECTIVE_WORKER_PHASES)[number];

/**
 * Durable worker-record lifecycle for one parallel objective. `created` records
 * the worker session identity for one attempt, `settled` binds the attempt to
 * the Git-derived commit it produced (or `null` when no commit was produced),
 * and `disposed` closes the objective's worker record. A worker commit is
 * evidence for integration, never a run result by itself.
 */
export const ObjectiveWorkerPayloadSchema = Schema.Struct({
  phase: Schema.Literals(OBJECTIVE_WORKER_PHASES),
  objectiveId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  attempt: PositiveCount,
  generation: PositiveCount,
  commit: Schema.NullOr(GitCommitId),
});

export type ObjectiveWorkerPayload = (typeof ObjectiveWorkerPayloadSchema)['Type'];

/**
 * Retirement of evidence that was valid for an earlier accepted result head.
 * A new accepted head makes prior commit-bound checks and Tester observations
 * unable to approve it; the event names the retired kind, its commit, and the
 * exact history revision being retired so the retirement stays auditable.
 */
export const EVIDENCE_RETIRED_KINDS = ['verification', 'tester-observation'] as const;

export type EvidenceRetiredKind = (typeof EVIDENCE_RETIRED_KINDS)[number];

export const EvidenceInvalidatedPayloadSchema = Schema.Struct({
  retiredKinds: Schema.Literals(EVIDENCE_RETIRED_KINDS),
  reason: Schema.NonEmptyString,
  retiredCommit: Schema.NonEmptyString,
  retiredRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export type EvidenceInvalidatedPayload = (typeof EvidenceInvalidatedPayloadSchema)['Type'];

/**
 * Commit binding for a settled Tester observation. Reviewer runtime evidence is
 * counted only when an observation is bound to the current result head, so an
 * observation of a previous commit can never approve a corrected result.
 */
export const EvidenceBoundPayloadSchema = Schema.Struct({
  kind: Schema.Literal('tester-observation'),
  sessionId: Schema.NonEmptyString,
  commit: Schema.NonEmptyString,
});

export type EvidenceBoundPayload = (typeof EvidenceBoundPayloadSchema)['Type'];

/**
 * The permissions that authenticate a decision command. A maintain or admin
 * repository permission is required, and the observed value is retained so the
 * applied choice stays auditable even if permission changes later.
 */
export const DECISION_PERMISSION_SNAPSHOTS = ['admin', 'maintain'] as const;

export type DecisionPermissionSnapshot = (typeof DECISION_PERMISSION_SNAPSHOTS)[number];

/**
 * Durable evidence that one exact authenticated command selected a labelled
 * option. The comment body is never stored; its hash plus the comment id,
 * author, and permission snapshot make later edits or deletion unable to undo
 * the recorded decision.
 */
export const DecisionAppliedPayloadSchema = Schema.Struct({
  decisionId: DecisionId,
  optionId: DecisionOptionId,
  action: Schema.Literals(REVIEWER_DECISION_ACTIONS),
  commentId: Schema.NonEmptyString,
  author: Schema.NonEmptyString,
  bodyHash: Sha256Hex,
  permissionSnapshot: Schema.Literals(DECISION_PERMISSION_SNAPSHOTS),
});

export type DecisionAppliedPayload = (typeof DecisionAppliedPayloadSchema)['Type'];

/**
 * Durable agreement that a partially completed decision publication has been
 * reconciled in place. `agreement` names the strongest journal fact the resume
 * reconciled from, and a `publication-reconciled` event is appended only after
 * the exact draft URL is durable.
 */
export const PUBLICATION_RECONCILIATION_AGREEMENTS = ['push', 'pull-request', 'draft-url'] as const;

export type PublicationReconciliationAgreement =
  (typeof PUBLICATION_RECONCILIATION_AGREEMENTS)[number];

export const PublicationReconciledPayloadSchema = Schema.Struct({
  agreement: Schema.Literals(PUBLICATION_RECONCILIATION_AGREEMENTS),
  detail: Schema.String,
});

export type PublicationReconciledPayload = (typeof PublicationReconciledPayloadSchema)['Type'];

/**
 * The accepted integration plan recorded before Lead Coder starts: the complete
 * objective set, the Git-derived commit accepted for each objective, and the
 * declared application order. Arrival order cannot silently redefine the plan
 * because the declared order is fixed here, not inferred from worker settling.
 */
export const IntegrationDeclaredPayloadSchema = Schema.Struct({
  objectiveIds: Schema.Array(Schema.NonEmptyString),
  commits: Schema.Array(GitCommitId),
  declaredOrder: Schema.Array(Schema.NonEmptyString),
});

export type IntegrationDeclaredPayload = (typeof IntegrationDeclaredPayloadSchema)['Type'];

/**
 * The verified outcome of Lead Coder integration: the single aggregate commit
 * that contains every accepted contribution, the actual Git contribution
 * application order, and the reason when that order deviates from the declared
 * order. The aggregate commit is the only candidate result.
 */
export const IntegrationCompletedPayloadSchema = Schema.Struct({
  aggregateCommit: GitCommitId,
  actualOrder: Schema.Array(Schema.NonEmptyString),
  deviationReason: Schema.NullOr(Schema.NonEmptyString),
});

export type IntegrationCompletedPayload = (typeof IntegrationCompletedPayloadSchema)['Type'];

export const EVIDENCE_MANIFEST_KINDS = ['capture', 'log', 'note'] as const;

export type EvidenceManifestKind = (typeof EVIDENCE_MANIFEST_KINDS)[number];

/**
 * One bounded capture a settled Tester turn offers as observation evidence for
 * the current result head. A non-null `sha256` proves content; a null hash is a
 * name-only claim. `criterionIds` links the capture to the accepted-plan
 * criteria it is offered to support, and `note` marks pre-existing
 * informational copy/UX observations that can never prove a criterion alone.
 */
export const EvidenceManifestEntrySchema = Schema.Struct({
  sha256: Schema.NullOr(Sha256Hex),
  byteLength: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  label: Schema.NonEmptyString,
  kind: Schema.Literals(EVIDENCE_MANIFEST_KINDS),
  criterionIds: Schema.Array(Schema.NonEmptyString),
});

export type EvidenceManifestEntry = (typeof EvidenceManifestEntrySchema)['Type'];

/**
 * The capture inventory for one result head. Two entries with the same sha256
 * are one observation regardless of their labels; the manifest records what was
 * captured, never whether a criterion passed.
 */
export const EvidenceManifestPayloadSchema = Schema.Struct({
  entries: Schema.Array(EvidenceManifestEntrySchema),
});

export type EvidenceManifestPayload = (typeof EvidenceManifestPayloadSchema)['Type'];

export const RECOVERY_DISPOSITIONS = [
  'accept',
  'continue_waiting',
  'retry',
  'blocked',
  'human_recovery',
] as const;

export type RecoveryDisposition = (typeof RECOVERY_DISPOSITIONS)[number];

/**
 * Durable record of one recovery disposition chosen for a resumable run. The
 * disposition is an audit fact about how Foundry reconciled recorded evidence;
 * it is never a workflow transition by itself. A `human_recovery` disposition
 * is an integrity stop for a person, not a manual workflow mode.
 */
export const RecoveryRecordedPayloadSchema = Schema.Struct({
  disposition: Schema.Literals(RECOVERY_DISPOSITIONS),
  reason: Schema.NonEmptyString,
});

export type RecoveryRecordedPayload = (typeof RecoveryRecordedPayloadSchema)['Type'];

/**
 * The result channel's own publication-checkpoint vocabulary. It is deliberately
 * narrower than the decision journal's `PUBLICATION_CHECKPOINT_STAGES`: the
 * result channel never locates a reusable draft PR, and its `direct-merge` mode
 * updates the source branch instead of opening a pull request, while
 * `non-draft-pr-auto-merge` records the additional `auto-merge-enabled` stage.
 */
export const RESULT_PUBLICATION_CHECKPOINT_STAGES = [
  'pre-push',
  'pushed',
  'pull-request-created',
  'url-recorded',
  'auto-merge-enabled',
  'source-branch-updated',
] as const;

export type ResultPublicationCheckpointStage =
  (typeof RESULT_PUBLICATION_CHECKPOINT_STAGES)[number];

/**
 * The result stages that only a pull-request mode can record. The `direct-merge`
 * mode shares `pre-push` and `source-branch-updated`, so a direct merge may
 * legitimately follow a `pre-push` checkpoint but never a pull-request stage.
 */
const RESULT_PULL_REQUEST_CHECKPOINT_STAGES: ReadonlySet<ResultPublicationCheckpointStage> =
  new Set(['pushed', 'pull-request-created', 'url-recorded', 'auto-merge-enabled']);

/**
 * One durable step of the approved-result publication transaction. A result PR
 * is published for a changed, already-approved result after the run reached a
 * terminal success state, so it reuses the decision-publication stage
 * vocabulary but is never part of the decision channel. Only `url-recorded` may
 * carry the authoritative pull request URL.
 */
export const ResultPrCheckpointPayloadSchema = Schema.Struct({
  stage: Schema.Literals(RESULT_PUBLICATION_CHECKPOINT_STAGES),
  url: Schema.NullOr(Schema.NonEmptyString),
  commit: GitCommitId,
  detail: Schema.String,
});

export type ResultPrCheckpointPayload = (typeof ResultPrCheckpointPayloadSchema)['Type'];

/**
 * The settled fact that an approved changed result has exactly one ordinary
 * (non-draft) result pull request for the task branch and accepted commit.
 * Recording it makes a resumed reconciliation a no-op and lets the handoff and
 * run report name the exact URL without touching GitHub again.
 */
export const ResultPrRecordedPayloadSchema = Schema.Struct({
  url: Schema.NonEmptyString,
  commit: GitCommitId,
  taskBranch: Schema.NonEmptyString,
});

export type ResultPrRecordedPayload = (typeof ResultPrRecordedPayloadSchema)['Type'];

/**
 * The settled fact that an approved changed result was taken forward by updating
 * the configured source branch instead of opening a pull request. `fastForward`
 * records whether the source branch moved to a descendant of its previous head;
 * `false` means the leased force-with-lease push authorized a non-fast-forward
 * overwrite from Gits own observed state. Recording it makes a resumed
 * reconciliation a no-op and lets the handoff and run report name the exact
 * merged commit without touching the remote again.
 */
export const ResultMergeRecordedPayloadSchema = Schema.Struct({
  commit: GitCommitId,
  taskBranch: Schema.NonEmptyString,
  remote: Schema.NonEmptyString,
  sourceBranch: Schema.NonEmptyString,
  fastForward: Schema.Boolean,
});

export type ResultMergeRecordedPayload = (typeof ResultMergeRecordedPayloadSchema)['Type'];

/**
 * Durable operator reason for an explicit abandonment. Abandonment is explicit
 * operator intent, not recovery, so it is recorded as its own audit note after
 * the terminal `abandoned` transition; the transition payload itself carries
 * only the route and states.
 */
export const AbandonmentNotePayloadSchema = Schema.Struct({
  reason: Schema.NonEmptyString,
});

export type AbandonmentNotePayload = (typeof AbandonmentNotePayloadSchema)['Type'];

const RunEventEnvelopeFields = {
  schemaVersion: Schema.Literal(RUN_HISTORY_SCHEMA_VERSION),
  runId: Identifier,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  eventId: RunEventId,
  occurredAt: UtcInstant,
  previousEventHash: Schema.NullOr(Sha256Hex),
  eventHash: Sha256Hex,
};

export const RunCreatedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('run-created'),
  payload: RunCreatedPayloadSchema,
});

export const SourceFrozenEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('source-frozen'),
  payload: SourceFrozenPayloadSchema,
});

export const GuidanceFrozenEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('guidance-frozen'),
  payload: GuidanceFrozenPayloadSchema,
});

export const WorktreeReadyEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('worktree-ready'),
  payload: WorktreeReadyPayloadSchema,
});

export const WorkflowTransitionEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('workflow-transition'),
  payload: WorkflowTransitionPayloadSchema,
});

export const WorkflowAttemptEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('workflow-attempt'),
  payload: WorkflowAttemptPayloadSchema,
});

export const CleanupProgressEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('cleanup-progress'),
  payload: CleanupProgressPayloadSchema,
});

export const RoleSessionCreatedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('role-session-created'),
  payload: RoleSessionCreatedPayloadSchema,
});

export const RoleSessionSubmissionRequestedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('role-session-submission-requested'),
  payload: RoleSessionSubmissionRequestedPayloadSchema,
});

export const RoleSessionSubmissionStartedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('role-session-submission-started'),
  payload: RoleSessionSubmissionStartedPayloadSchema,
});

export const RoleSessionObservedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('role-session-observed'),
  payload: RoleSessionObservedPayloadSchema,
});

export const RoleSessionStoppedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('role-session-stopped'),
  payload: RoleSessionStoppedPayloadSchema,
});

export const RoleControlRejectedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('role-control-rejected'),
  payload: RoleControlRejectedPayloadSchema,
});

export const RoleControlRepairRequestedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('role-control-repair-requested'),
  payload: RoleControlRepairRequestedPayloadSchema,
});

export const RoleControlRepairStartedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('role-control-repair-started'),
  payload: RoleControlRepairStartedPayloadSchema,
});

export const PlanAcceptedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('plan-accepted'),
  payload: PlanAcceptedPayloadSchema,
});

export const FindingRecordedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('finding-recorded'),
  payload: FindingRecordedPayloadSchema,
});

export const RolePermissionViolationEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('role-permission-violation'),
  payload: RolePermissionViolationPayloadSchema,
});

export const ImplementationAcceptedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('implementation-accepted'),
  payload: ImplementationAcceptedPayloadSchema,
});

export const VerificationCompletedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('verification-completed'),
  payload: VerificationCompletedPayloadSchema,
});

export const TesterSkippedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('tester-skipped'),
  payload: TesterSkippedPayloadSchema,
});

export const ValidationLimitationEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('validation-limitation'),
  payload: ValidationLimitationPayloadSchema,
});

export const RuntimeLifecycleEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('runtime-lifecycle'),
  payload: RuntimeLifecyclePayloadSchema,
});

export const DecisionOpenedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('decision-opened'),
  payload: DecisionOpenedPayloadSchema,
});

export const PublicationCheckpointEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('publication-checkpoint'),
  payload: PublicationCheckpointPayloadSchema,
});

export const ObjectiveWorkerEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('objective-worker'),
  payload: ObjectiveWorkerPayloadSchema,
});

export const EvidenceInvalidatedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('evidence-invalidated'),
  payload: EvidenceInvalidatedPayloadSchema,
});

export const EvidenceBoundEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('evidence-bound'),
  payload: EvidenceBoundPayloadSchema,
});

export const DecisionAppliedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('decision-applied'),
  payload: DecisionAppliedPayloadSchema,
});

export const PublicationReconciledEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('publication-reconciled'),
  payload: PublicationReconciledPayloadSchema,
});

export const IntegrationDeclaredEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('integration-declared'),
  payload: IntegrationDeclaredPayloadSchema,
});

export const IntegrationCompletedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('integration-completed'),
  payload: IntegrationCompletedPayloadSchema,
});

export const EvidenceManifestEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('evidence-manifest'),
  payload: EvidenceManifestPayloadSchema,
});

export const RecoveryRecordedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('recovery-recorded'),
  payload: RecoveryRecordedPayloadSchema,
});

export const ResultPrCheckpointEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('result-pr-checkpoint'),
  payload: ResultPrCheckpointPayloadSchema,
});

export const ResultPrRecordedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('result-pr-recorded'),
  payload: ResultPrRecordedPayloadSchema,
});

export const ResultMergeRecordedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('result-merge-recorded'),
  payload: ResultMergeRecordedPayloadSchema,
});

export const AbandonmentNoteEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('abandonment-note'),
  payload: AbandonmentNotePayloadSchema,
});

export const RunEventSchema = Schema.Union([
  RunCreatedEventSchema,
  SourceFrozenEventSchema,
  GuidanceFrozenEventSchema,
  WorktreeReadyEventSchema,
  WorkflowTransitionEventSchema,
  WorkflowAttemptEventSchema,
  CleanupProgressEventSchema,
  RoleSessionCreatedEventSchema,
  RoleSessionSubmissionRequestedEventSchema,
  RoleSessionSubmissionStartedEventSchema,
  RoleSessionObservedEventSchema,
  RoleSessionStoppedEventSchema,
  RoleControlRejectedEventSchema,
  RoleControlRepairRequestedEventSchema,
  RoleControlRepairStartedEventSchema,
  PlanAcceptedEventSchema,
  FindingRecordedEventSchema,
  RolePermissionViolationEventSchema,
  ImplementationAcceptedEventSchema,
  VerificationCompletedEventSchema,
  TesterSkippedEventSchema,
  ValidationLimitationEventSchema,
  RuntimeLifecycleEventSchema,
  DecisionOpenedEventSchema,
  PublicationCheckpointEventSchema,
  ObjectiveWorkerEventSchema,
  EvidenceInvalidatedEventSchema,
  EvidenceBoundEventSchema,
  DecisionAppliedEventSchema,
  PublicationReconciledEventSchema,
  IntegrationDeclaredEventSchema,
  IntegrationCompletedEventSchema,
  EvidenceManifestEventSchema,
  RecoveryRecordedEventSchema,
  ResultPrCheckpointEventSchema,
  ResultPrRecordedEventSchema,
  ResultMergeRecordedEventSchema,
  AbandonmentNoteEventSchema,
]);

export type RunEvent = (typeof RunEventSchema)['Type'];

export type RunEventEnvelope = {
  readonly schemaVersion: typeof RUN_HISTORY_SCHEMA_VERSION;
  readonly runId: string;
  readonly revision: number;
  readonly eventId: string;
  readonly occurredAt: string;
  readonly previousEventHash: string | null;
};

export type RunEventDraft =
  | { readonly type: 'run-created'; readonly payload: RunCreatedPayload }
  | { readonly type: 'source-frozen'; readonly payload: SourceFrozenPayload }
  | { readonly type: 'guidance-frozen'; readonly payload: GuidanceFrozenPayload }
  | { readonly type: 'worktree-ready'; readonly payload: WorktreeReadyPayload }
  | { readonly type: 'workflow-transition'; readonly payload: WorkflowTransitionPayload }
  | { readonly type: 'workflow-attempt'; readonly payload: WorkflowAttemptPayload }
  | { readonly type: 'cleanup-progress'; readonly payload: CleanupProgressPayload }
  | { readonly type: 'role-session-created'; readonly payload: RoleSessionCreatedPayload }
  | {
      readonly type: 'role-session-submission-requested';
      readonly payload: RoleSessionSubmissionRequestedPayload;
    }
  | {
      readonly type: 'role-session-submission-started';
      readonly payload: RoleSessionSubmissionStartedPayload;
    }
  | { readonly type: 'role-session-observed'; readonly payload: RoleSessionObservedPayload }
  | { readonly type: 'role-session-stopped'; readonly payload: RoleSessionStoppedPayload }
  | { readonly type: 'role-control-rejected'; readonly payload: RoleControlRejectedPayload }
  | {
      readonly type: 'role-control-repair-requested';
      readonly payload: RoleControlRepairRequestedPayload;
    }
  | {
      readonly type: 'role-control-repair-started';
      readonly payload: RoleControlRepairStartedPayload;
    }
  | { readonly type: 'plan-accepted'; readonly payload: PlanAcceptedPayload }
  | { readonly type: 'finding-recorded'; readonly payload: FindingRecordedPayload }
  | {
      readonly type: 'role-permission-violation';
      readonly payload: RolePermissionViolationPayload;
    }
  | {
      readonly type: 'implementation-accepted';
      readonly payload: ImplementationAcceptedPayload;
    }
  | {
      readonly type: 'verification-completed';
      readonly payload: VerificationCompletedPayload;
    }
  | { readonly type: 'tester-skipped'; readonly payload: TesterSkippedPayload }
  | { readonly type: 'validation-limitation'; readonly payload: ValidationLimitationPayload }
  | { readonly type: 'runtime-lifecycle'; readonly payload: RuntimeLifecyclePayload }
  | { readonly type: 'decision-opened'; readonly payload: DecisionOpenedPayload }
  | { readonly type: 'publication-checkpoint'; readonly payload: PublicationCheckpointPayload }
  | { readonly type: 'objective-worker'; readonly payload: ObjectiveWorkerPayload }
  | {
      readonly type: 'evidence-invalidated';
      readonly payload: EvidenceInvalidatedPayload;
    }
  | { readonly type: 'evidence-bound'; readonly payload: EvidenceBoundPayload }
  | { readonly type: 'decision-applied'; readonly payload: DecisionAppliedPayload }
  | {
      readonly type: 'publication-reconciled';
      readonly payload: PublicationReconciledPayload;
    }
  | {
      readonly type: 'integration-declared';
      readonly payload: IntegrationDeclaredPayload;
    }
  | {
      readonly type: 'integration-completed';
      readonly payload: IntegrationCompletedPayload;
    }
  | { readonly type: 'evidence-manifest'; readonly payload: EvidenceManifestPayload }
  | { readonly type: 'recovery-recorded'; readonly payload: RecoveryRecordedPayload }
  | { readonly type: 'result-pr-checkpoint'; readonly payload: ResultPrCheckpointPayload }
  | { readonly type: 'result-pr-recorded'; readonly payload: ResultPrRecordedPayload }
  | { readonly type: 'result-merge-recorded'; readonly payload: ResultMergeRecordedPayload }
  | { readonly type: 'abandonment-note'; readonly payload: AbandonmentNotePayload };

export type UnsignedRunEvent = RunEventDraft & RunEventEnvelope;

export type RunEventOf<Draft extends RunEventDraft> = Draft &
  RunEventEnvelope & { readonly eventHash: string };

export interface RunHistoryHead {
  readonly revision: number;
  readonly eventHash: string | null;
}

export interface RunHistoryDerivedState {
  readonly state: WorkflowState | null;
  readonly checkpoint: WorkflowState | null;
  readonly attempts: ReadonlyArray<WorkflowAttempt>;
  readonly cleanupProgress: CleanupProgressPayload | null;
  readonly sourceFrozen: SourceFrozenPayload | null;
  readonly guidanceFrozen: GuidanceFrozenPayload | null;
  readonly worktreeReady: WorktreeReadyPayload | null;
  readonly roleSessions: ReadonlyArray<RoleHostSessionState>;
  readonly roleControlRepairs: ReadonlyArray<RoleControlRepairRecord>;
  readonly acceptedPlan: PlanAcceptedPayload | null;
  readonly findings: ReadonlyArray<FindingRecord>;
  readonly implementation: ImplementationAcceptedPayload | null;
  readonly permissionViolations: ReadonlyArray<RolePermissionViolationPayload>;
  readonly verifications: ReadonlyArray<VerificationCompletedPayload>;
  readonly testerSkips: ReadonlyArray<TesterSkippedPayload>;
  readonly validationLimitations: ReadonlyArray<ValidationLimitationPayload>;
  readonly runtimeLifecycles: ReadonlyArray<RuntimeLifecyclePayload>;
  readonly objectiveWorkers?: ReadonlyArray<ObjectiveWorkerPayload>;
  readonly evidenceInvalidations: ReadonlyArray<EvidenceInvalidatedPayload>;
  readonly evidenceBindings: ReadonlyArray<EvidenceBoundPayload>;
  readonly decisionApplieds: ReadonlyArray<DecisionAppliedPayload>;
  readonly integrationDeclared?: IntegrationDeclaredPayload | null;
  readonly integrationCompleted?: IntegrationCompletedPayload | null;
  readonly evidenceManifests: ReadonlyArray<EvidenceManifestPayload>;
  readonly recoveryDispositions: ReadonlyArray<RecoveryRecordedPayload>;
  readonly resultPrCheckpoints?: ReadonlyArray<ResultPrCheckpointPayload>;
  readonly resultPrRecorded?: ResultPrRecordedPayload | null;
  readonly resultMergeRecorded?: ResultMergeRecordedPayload | null;
  readonly abandonmentNotes?: ReadonlyArray<AbandonmentNotePayload>;
}

export type RunHistoryVerification =
  | {
      readonly ok: true;
      readonly head: RunHistoryHead;
      readonly derived: RunHistoryDerivedState;
    }
  | {
      readonly ok: false;
      readonly problem: string;
    };

export const RunHistoryWitnessSchema = Schema.Struct({
  schemaVersion: Schema.Literal(RUN_HISTORY_WITNESS_SCHEMA_VERSION),
  runId: Identifier,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  eventHash: Sha256Hex,
});

export type RunHistoryWitness = (typeof RunHistoryWitnessSchema)['Type'];

const CHECKPOINTED_TRANSITION_ROUTES: ReadonlySet<string> = new Set([
  'block-run',
  'publication-unavailable',
  'publication-unresolved',
]);

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonicalVerificationExecution(execution: VerificationExecution) {
  return {
    kind: execution.kind,
    name: execution.name,
    executable: execution.executable,
    arguments: [...execution.arguments],
    expectedExitCode: execution.expectedExitCode,
    actualExitCode: execution.actualExitCode,
    timedOut: execution.timedOut,
    durationMs: execution.durationMs,
    log: {
      path: execution.log.path,
      sha256: execution.log.sha256,
      byteLength: execution.log.byteLength,
      retainedByteLength: execution.log.retainedByteLength,
      truncated: execution.log.truncated,
      redactionCount: execution.log.redactionCount,
    },
    trackedMutation:
      execution.trackedMutation === null
        ? null
        : {
            sha256: execution.trackedMutation.sha256,
            byteLength: execution.trackedMutation.byteLength,
            retainedByteLength: execution.trackedMutation.retainedByteLength,
            truncated: execution.trackedMutation.truncated,
            diff: {
              path: execution.trackedMutation.diff.path,
              sha256: execution.trackedMutation.diff.sha256,
              byteLength: execution.trackedMutation.diff.byteLength,
              retainedByteLength: execution.trackedMutation.diff.retainedByteLength,
              truncated: execution.trackedMutation.diff.truncated,
              redactionCount: execution.trackedMutation.diff.redactionCount,
            },
          },
    reconstructed: execution.reconstructed,
    reconstructionError: execution.reconstructionError,
  };
}

function canonicalVerificationReport(report: VerificationCompletedPayload) {
  return {
    attempt: report.attempt,
    repository: report.repository,
    commit: report.commit,
    profileHash: report.profileHash,
    commandMs: report.commandMs,
    executions: report.executions.map(canonicalVerificationExecution),
    result: report.result,
  };
}

function canonicalRuntimeRecord(record: RuntimeLifecyclePayload) {
  return {
    repository: record.repository,
    commit: record.commit,
    baseUrl: record.baseUrl,
    runtimeKind: record.runtimeKind,
    startedAt: record.startedAt,
    readyAt: record.readyAt,
    stoppedAt: record.stoppedAt,
    outcome: record.outcome,
    cleanup: record.cleanup,
    dataPreserved: record.dataPreserved,
    stages: record.stages.map((stage) => ({
      name: stage.name,
      outcome: stage.outcome,
      durationMs: stage.durationMs,
      detail: stage.detail,
    })),
  };
}

function canonicalEventText(event: UnsignedRunEvent): string {
  switch (event.type) {
    case 'run-created':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: { taskId: event.payload.taskId },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'source-frozen':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          expectedHead: event.payload.expectedHead,
          repository: {
            gitDirectory: event.payload.repository.gitDirectory,
            remoteUrl: event.payload.repository.remoteUrl,
            repositoryRoot: event.payload.repository.repositoryRoot,
          },
          sourceBranch: event.payload.sourceBranch,
          sourceCommit: event.payload.sourceCommit,
          sourceRemote: event.payload.sourceRemote,
          taskBranch: event.payload.taskBranch,
          workspace: event.payload.workspace,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'guidance-frozen':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          aggregateHash: event.payload.aggregateHash,
          files: event.payload.files.map((file) => ({
            byteLength: file.byteLength,
            contentHash: file.contentHash,
            path: file.path,
            retainedPath: file.retainedPath,
          })),
          manifestPath: event.payload.manifestPath,
          sourceCommit: event.payload.sourceCommit,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'worktree-ready':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          baseCommit: event.payload.baseCommit,
          headCommit: event.payload.headCommit,
          taskBranch: event.payload.taskBranch,
          workspace: event.payload.workspace,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'workflow-transition':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          checkpoint: event.payload.checkpoint,
          from: event.payload.from,
          route: event.payload.route,
          to: event.payload.to,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'workflow-attempt':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          kind: event.payload.kind,
          reason: event.payload.reason,
          role: event.payload.role,
          sequence: event.payload.sequence,
          state: event.payload.state,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'cleanup-progress':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          detail: event.payload.detail,
          outcome: event.payload.outcome,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'role-session-created':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          attempt: event.payload.attempt,
          generation: event.payload.generation,
          ownershipToken: event.payload.ownershipToken,
          role: event.payload.role,
          runtimeIdentity: {
            adapterVersion: event.payload.runtimeIdentity.adapterVersion,
            model: event.payload.runtimeIdentity.model,
            provider: event.payload.runtimeIdentity.provider,
            toolProfile: event.payload.runtimeIdentity.toolProfile,
          },
          sequence: event.payload.sequence,
          sessionId: event.payload.sessionId,
          workingDirectory: event.payload.workingDirectory,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'role-session-submission-requested':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          baselineSequence: event.payload.baselineSequence,
          generation: event.payload.generation,
          idempotencyKey: event.payload.idempotencyKey,
          kind: event.payload.kind ?? null,
          promptHash: event.payload.promptHash,
          repair:
            event.payload.repair === undefined || event.payload.repair === null
              ? null
              : {
                  rejectedControl: event.payload.repair.rejectedControl,
                  rejectedControlHash: event.payload.repair.rejectedControlHash,
                  rejectedNarrativeHash: event.payload.repair.rejectedNarrativeHash,
                  rejectedSequence: event.payload.repair.rejectedSequence,
                  validationError: event.payload.repair.validationError,
                },
          sessionId: event.payload.sessionId,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'role-session-submission-started':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          generation: event.payload.generation,
          idempotencyKey: event.payload.idempotencyKey,
          sessionId: event.payload.sessionId,
          submission: event.payload.submission,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'role-session-observed':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          control: event.payload.control,
          eventCount: event.payload.eventCount,
          generation: event.payload.generation,
          narrative: event.payload.narrative,
          sequence: event.payload.sequence,
          sessionId: event.payload.sessionId,
          status: event.payload.status,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'role-session-stopped':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          disposition: event.payload.disposition,
          generation: event.payload.generation,
          sessionId: event.payload.sessionId,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'role-control-rejected':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          controlHash: event.payload.controlHash,
          generation: event.payload.generation,
          narrativeHash: event.payload.narrativeHash,
          problem: event.payload.problem,
          sequence: event.payload.sequence,
          sessionId: event.payload.sessionId,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'role-control-repair-requested':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          baselineSequence: event.payload.baselineSequence,
          generation: event.payload.generation,
          idempotencyKey: event.payload.idempotencyKey,
          problem: event.payload.problem,
          promptHash: event.payload.promptHash,
          sessionId: event.payload.sessionId,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'role-control-repair-started':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          generation: event.payload.generation,
          idempotencyKey: event.payload.idempotencyKey,
          sessionId: event.payload.sessionId,
          submission: event.payload.submission,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'plan-accepted':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          criteria: event.payload.criteria.map((criterion) => ({
            id: criterion.id,
            text: criterion.text,
          })),
          execution: {
            mode: event.payload.execution.mode,
            objectives: event.payload.execution.objectives.map((objective) => ({
              affectedPaths: objective.affectedPaths,
              criterionIds: objective.criterionIds,
              id: objective.id,
              title: objective.title,
            })),
          },
          outcome: event.payload.outcome,
          runtimeValidationRequired: event.payload.runtimeValidationRequired,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'finding-recorded':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          blocking: event.payload.blocking,
          category: event.payload.category,
          commit: event.payload.commit,
          description: event.payload.description,
          detail: event.payload.detail,
          evidence: event.payload.evidence,
          id: event.payload.id,
          owner: event.payload.owner,
          severity: event.payload.severity,
          source: event.payload.source,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'role-permission-violation':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          attempt: event.payload.attempt,
          detail: event.payload.detail,
          kind: event.payload.kind,
          role: event.payload.role,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'implementation-accepted':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          baseCommit: event.payload.baseCommit,
          changedFiles: event.payload.changedFiles,
          commit: event.payload.commit,
          noChangeCandidate: event.payload.noChangeCandidate,
          taskBranch: event.payload.taskBranch,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'verification-completed':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: canonicalVerificationReport(event.payload),
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'tester-skipped':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          reason: event.payload.reason,
          verificationCommit: event.payload.verificationCommit,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'runtime-lifecycle':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: canonicalRuntimeRecord(event.payload),
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'validation-limitation':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          commit: event.payload.commit,
          reason: event.payload.reason,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'decision-opened':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          decisionId: event.payload.decisionId,
          nonce: event.payload.nonce,
          options: event.payload.options.map((option) => ({
            action: option.action,
            id: option.id,
            label: option.label,
          })),
          question: event.payload.question,
          recommendation: event.payload.recommendation,
          resultCommit: event.payload.resultCommit,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'publication-checkpoint':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          decisionId: event.payload.decisionId,
          detail: event.payload.detail,
          draftPrUrl: event.payload.draftPrUrl,
          stage: event.payload.stage,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'objective-worker':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          attempt: event.payload.attempt,
          commit: event.payload.commit,
          generation: event.payload.generation,
          objectiveId: event.payload.objectiveId,
          phase: event.payload.phase,
          sessionId: event.payload.sessionId,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'evidence-invalidated':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          reason: event.payload.reason,
          retiredCommit: event.payload.retiredCommit,
          retiredKinds: event.payload.retiredKinds,
          retiredRevision: event.payload.retiredRevision,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'evidence-bound':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          commit: event.payload.commit,
          kind: event.payload.kind,
          sessionId: event.payload.sessionId,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'decision-applied':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          action: event.payload.action,
          author: event.payload.author,
          bodyHash: event.payload.bodyHash,
          commentId: event.payload.commentId,
          decisionId: event.payload.decisionId,
          optionId: event.payload.optionId,
          permissionSnapshot: event.payload.permissionSnapshot,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'publication-reconciled':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          agreement: event.payload.agreement,
          detail: event.payload.detail,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'integration-declared':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          commits: event.payload.commits,
          declaredOrder: event.payload.declaredOrder,
          objectiveIds: event.payload.objectiveIds,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'integration-completed':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          actualOrder: event.payload.actualOrder,
          aggregateCommit: event.payload.aggregateCommit,
          deviationReason: event.payload.deviationReason,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'evidence-manifest':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          entries: event.payload.entries.map((entry) => ({
            byteLength: entry.byteLength,
            criterionIds: entry.criterionIds,
            kind: entry.kind,
            label: entry.label,
            sha256: entry.sha256,
          })),
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'recovery-recorded':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          disposition: event.payload.disposition,
          reason: event.payload.reason,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'result-pr-checkpoint':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          commit: event.payload.commit,
          detail: event.payload.detail,
          stage: event.payload.stage,
          url: event.payload.url,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'result-pr-recorded':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          commit: event.payload.commit,
          taskBranch: event.payload.taskBranch,
          url: event.payload.url,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'result-merge-recorded':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          commit: event.payload.commit,
          fastForward: event.payload.fastForward,
          remote: event.payload.remote,
          sourceBranch: event.payload.sourceBranch,
          taskBranch: event.payload.taskBranch,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
    case 'abandonment-note':
      return JSON.stringify({
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: {
          reason: event.payload.reason,
        },
        previousEventHash: event.previousEventHash,
        revision: event.revision,
        runId: event.runId,
        schemaVersion: event.schemaVersion,
        type: event.type,
      });
  }
}

export function computeRunEventHash(event: UnsignedRunEvent): string {
  const previousHash = event.previousEventHash ?? '';
  return createHash('sha256')
    .update(`${previousHash}\n${canonicalEventText(event)}`, 'utf8')
    .digest('hex');
}

export function sealRunEvent<Draft extends RunEventDraft>(
  envelope: RunEventEnvelope,
  draft: Draft,
): RunEventOf<Draft> {
  return Object.assign({}, envelope, draft, {
    eventHash: computeRunEventHash({ ...envelope, ...draft }),
  });
}

export function unsignedRunEvent(event: RunEvent): UnsignedRunEvent {
  const envelope = {
    schemaVersion: event.schemaVersion,
    runId: event.runId,
    revision: event.revision,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    previousEventHash: event.previousEventHash,
  };
  switch (event.type) {
    case 'run-created':
      return { ...envelope, type: 'run-created', payload: event.payload };
    case 'source-frozen':
      return { ...envelope, type: 'source-frozen', payload: event.payload };
    case 'guidance-frozen':
      return { ...envelope, type: 'guidance-frozen', payload: event.payload };
    case 'worktree-ready':
      return { ...envelope, type: 'worktree-ready', payload: event.payload };
    case 'workflow-transition':
      return { ...envelope, type: 'workflow-transition', payload: event.payload };
    case 'workflow-attempt':
      return { ...envelope, type: 'workflow-attempt', payload: event.payload };
    case 'cleanup-progress':
      return { ...envelope, type: 'cleanup-progress', payload: event.payload };
    case 'role-session-created':
      return { ...envelope, type: 'role-session-created', payload: event.payload };
    case 'role-session-submission-requested':
      return { ...envelope, type: 'role-session-submission-requested', payload: event.payload };
    case 'role-session-submission-started':
      return { ...envelope, type: 'role-session-submission-started', payload: event.payload };
    case 'role-session-observed':
      return { ...envelope, type: 'role-session-observed', payload: event.payload };
    case 'role-session-stopped':
      return { ...envelope, type: 'role-session-stopped', payload: event.payload };
    case 'role-control-rejected':
      return { ...envelope, type: 'role-control-rejected', payload: event.payload };
    case 'role-control-repair-requested':
      return { ...envelope, type: 'role-control-repair-requested', payload: event.payload };
    case 'role-control-repair-started':
      return { ...envelope, type: 'role-control-repair-started', payload: event.payload };
    case 'plan-accepted':
      return { ...envelope, type: 'plan-accepted', payload: event.payload };
    case 'finding-recorded':
      return { ...envelope, type: 'finding-recorded', payload: event.payload };
    case 'role-permission-violation':
      return { ...envelope, type: 'role-permission-violation', payload: event.payload };
    case 'implementation-accepted':
      return { ...envelope, type: 'implementation-accepted', payload: event.payload };
    case 'verification-completed':
      return { ...envelope, type: 'verification-completed', payload: event.payload };
    case 'tester-skipped':
      return { ...envelope, type: 'tester-skipped', payload: event.payload };
    case 'validation-limitation':
      return { ...envelope, type: 'validation-limitation', payload: event.payload };
    case 'runtime-lifecycle':
      return { ...envelope, type: 'runtime-lifecycle', payload: event.payload };
    case 'decision-opened':
      return { ...envelope, type: 'decision-opened', payload: event.payload };
    case 'publication-checkpoint':
      return { ...envelope, type: 'publication-checkpoint', payload: event.payload };
    case 'objective-worker':
      return { ...envelope, type: 'objective-worker', payload: event.payload };
    case 'evidence-invalidated':
      return { ...envelope, type: 'evidence-invalidated', payload: event.payload };
    case 'evidence-bound':
      return { ...envelope, type: 'evidence-bound', payload: event.payload };
    case 'decision-applied':
      return { ...envelope, type: 'decision-applied', payload: event.payload };
    case 'publication-reconciled':
      return { ...envelope, type: 'publication-reconciled', payload: event.payload };
    case 'integration-declared':
      return { ...envelope, type: 'integration-declared', payload: event.payload };
    case 'integration-completed':
      return { ...envelope, type: 'integration-completed', payload: event.payload };
    case 'evidence-manifest':
      return { ...envelope, type: 'evidence-manifest', payload: event.payload };
    case 'recovery-recorded':
      return { ...envelope, type: 'recovery-recorded', payload: event.payload };
    case 'result-pr-checkpoint':
      return { ...envelope, type: 'result-pr-checkpoint', payload: event.payload };
    case 'result-pr-recorded':
      return { ...envelope, type: 'result-pr-recorded', payload: event.payload };
    case 'result-merge-recorded':
      return { ...envelope, type: 'result-merge-recorded', payload: event.payload };
    case 'abandonment-note':
      return { ...envelope, type: 'abandonment-note', payload: event.payload };
  }
}

export function encodeRunEventLine(event: RunEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export function encodeRunHistoryWitness(witness: RunHistoryWitness): Uint8Array {
  return new TextEncoder().encode(
    `${JSON.stringify({
      eventHash: witness.eventHash,
      revision: witness.revision,
      runId: witness.runId,
      schemaVersion: witness.schemaVersion,
    })}\n`,
  );
}

function verifyTransitionPayload(
  payload: WorkflowTransitionPayload,
  state: WorkflowState | null,
  checkpoint: WorkflowState | null,
): string | null {
  const definition = WORKFLOW_TRANSITION_ROUTES[payload.route];
  if (payload.from !== state) {
    return `a "${payload.route}" transition does not continue the recorded workflow state "${state ?? 'none'}"`;
  }
  if (!allowsWorkflowRouteFrom(definition.from, state)) {
    return `a "${payload.route}" transition is not allowed from "${state ?? 'none'}"`;
  }
  const nominalTarget = definition.to === 'recorded-checkpoint' ? null : definition.to;
  if (nominalTarget !== null && payload.to !== nominalTarget) {
    return `a "${payload.route}" transition targets "${payload.to}" instead of "${nominalTarget}"`;
  }
  if (payload.route === 'resume') {
    if (checkpoint === null) {
      return 'a "resume" transition has no recorded workflow checkpoint to re-enter';
    }
    if (payload.to !== checkpoint) {
      return `a "resume" transition re-enters "${payload.to}" instead of the recorded checkpoint "${checkpoint}"`;
    }
  }
  const expectedCheckpoint = CHECKPOINTED_TRANSITION_ROUTES.has(payload.route)
    ? payload.from
    : null;
  if (payload.checkpoint !== expectedCheckpoint) {
    return `a "${payload.route}" transition records an unexpected workflow checkpoint`;
  }
  return null;
}

interface RoleSessionVerification {
  state: RoleHostSessionState;
  readonly submissions: Array<{
    readonly kind: RoleSessionSubmissionKind;
    readonly idempotencyKey: string;
  }>;
  readonly startedIdempotencyKeys: Set<string>;
  pendingIdempotencyKey: string | null;
  awaitingObservation: boolean;
  expectedRepairNarrativeHash: string | null;
}

function hashUtf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashControl(control: RoleHostControl): string {
  return hashUtf8(JSON.stringify(control));
}

interface PendingControlRepair {
  sessionId: string;
  generation: number;
  sequence: number;
  narrativeHash: string;
  controlHash: string;
  problem: string;
  idempotencyKey: string;
  promptHash: string;
  baselineSequence: number;
  submission: RoleHostSubmission | null;
  observation: RoleHostObservation | null;
  phase: 'rejected' | 'requested' | 'started';
}

export function verifyRunHistoryEvents(
  events: ReadonlyArray<RunEvent>,
  runId: string,
): RunHistoryVerification {
  let state: WorkflowState | null = null;
  let checkpoint: WorkflowState | null = null;
  let cleanupProgress: CleanupProgressPayload | null = null;
  let sourceFrozen: SourceFrozenPayload | null = null;
  let guidanceFrozen: GuidanceFrozenPayload | null = null;
  let worktreeReady: WorktreeReadyPayload | null = null;
  const attempts: Array<WorkflowAttempt> = [];
  const roleSessions = new Map<string, RoleSessionVerification>();
  const roleControlRepairs: Array<RoleControlRepairRecord> = [];
  const pendingControlRepairs = new Map<string, PendingControlRepair>();
  const permissionViolations: Array<RolePermissionViolationPayload> = [];
  const verifications: Array<VerificationCompletedPayload> = [];
  const testerSkips: Array<TesterSkippedPayload> = [];
  const validationLimitations: Array<ValidationLimitationPayload> = [];
  const runtimeLifecycles: Array<RuntimeLifecyclePayload> = [];
  const objectiveWorkers: Array<ObjectiveWorkerPayload> = [];
  const evidenceInvalidations: Array<EvidenceInvalidatedPayload> = [];
  const evidenceBindings: Array<EvidenceBoundPayload> = [];
  const decisionApplieds: Array<DecisionAppliedPayload> = [];
  const openedDecisionIds = new Set<string>();
  let integrationDeclared: IntegrationDeclaredPayload | null = null;
  let integrationCompleted: IntegrationCompletedPayload | null = null;
  const evidenceManifests: Array<EvidenceManifestPayload> = [];
  const recoveryDispositions: Array<RecoveryRecordedPayload> = [];
  const resultPrCheckpoints: Array<ResultPrCheckpointPayload> = [];
  const resultPrCheckpointStageIndex = new Map<string, number>();
  let resultPrRecorded: ResultPrRecordedPayload | null = null;
  const recordedResultPrCommits = new Set<string>();
  let resultMergeRecorded: ResultMergeRecordedPayload | null = null;
  const recordedResultMergeCommits = new Set<string>();
  const abandonmentNotes: Array<AbandonmentNotePayload> = [];
  let changedResultApproved = false;
  const retiredRevisions = new Set<number>();
  const findings: Array<FindingRecord> = [];
  let acceptedPlan: PlanAcceptedPayload | null = null;
  let implementation: ImplementationAcceptedPayload | null = null;
  let previousHash: string | null = null;
  let decisionOpened: DecisionOpenedPayload | null = null;
  let decisionApplied: DecisionAppliedPayload | null = null;
  let lastPublicationCheckpoint: PublicationCheckpointStage | null = null;

  const currentResultCommit = (): string | null =>
    implementation === null ? null : (implementation.commit ?? implementation.baseCommit);

  for (const [index, event] of events.entries()) {
    const label = `event ${index + 1}`;
    if (event.revision !== index + 1) {
      return {
        ok: false,
        problem: `${label} has revision ${event.revision} instead of the consecutive revision ${index + 1}`,
      };
    }
    if (event.runId !== runId) {
      return { ok: false, problem: `${label} belongs to run "${event.runId}", not "${runId}"` };
    }
    if (event.previousEventHash !== previousHash) {
      return { ok: false, problem: `${label} does not link to the previous event hash` };
    }
    const computedHash = computeRunEventHash(unsignedRunEvent(event));
    if (computedHash !== event.eventHash) {
      return { ok: false, problem: `${label} hash does not match its contents` };
    }
    if (index === 0 && event.type !== 'run-created') {
      return { ok: false, problem: 'history does not begin with run creation' };
    }
    switch (event.type) {
      case 'run-created': {
        if (index !== 0) {
          return { ok: false, problem: `run creation appears again at ${label}` };
        }
        state = null;
        checkpoint = null;
        break;
      }
      case 'source-frozen': {
        if (state !== null) {
          return {
            ok: false,
            problem: `${label} records a source freeze after workflow work began`,
          };
        }
        if (sourceFrozen !== null) {
          return { ok: false, problem: `source freeze appears again at ${label}` };
        }
        if (event.payload.expectedHead !== event.payload.sourceCommit) {
          return {
            ok: false,
            problem: `${label} records an expected head that differs from the frozen source commit`,
          };
        }
        sourceFrozen = event.payload;
        break;
      }
      case 'guidance-frozen': {
        if (state !== null) {
          return {
            ok: false,
            problem: `${label} records frozen guidance after workflow work began`,
          };
        }
        if (sourceFrozen === null) {
          return {
            ok: false,
            problem: `${label} records frozen guidance before the source freeze`,
          };
        }
        if (guidanceFrozen !== null) {
          return { ok: false, problem: `frozen guidance appears again at ${label}` };
        }
        if (event.payload.sourceCommit !== sourceFrozen.sourceCommit) {
          return {
            ok: false,
            problem: `${label} records guidance for a different source commit`,
          };
        }
        guidanceFrozen = event.payload;
        break;
      }
      case 'worktree-ready': {
        if (state !== null) {
          return {
            ok: false,
            problem: `${label} records worktree readiness after workflow work began`,
          };
        }
        if (sourceFrozen === null) {
          return {
            ok: false,
            problem: `${label} records worktree readiness before the source freeze`,
          };
        }
        if (worktreeReady !== null) {
          return { ok: false, problem: `worktree readiness appears again at ${label}` };
        }
        if (
          event.payload.taskBranch !== sourceFrozen.taskBranch ||
          event.payload.workspace !== sourceFrozen.workspace
        ) {
          return {
            ok: false,
            problem: `${label} records a worktree that differs from the frozen run identity`,
          };
        }
        if (
          event.payload.headCommit !== sourceFrozen.sourceCommit ||
          event.payload.baseCommit !== sourceFrozen.sourceCommit
        ) {
          return {
            ok: false,
            problem: `${label} records a worktree head or base that differs from the frozen source commit`,
          };
        }
        worktreeReady = event.payload;
        break;
      }
      case 'workflow-transition': {
        if (event.payload.route === 'run-created' && worktreeReady === null) {
          return {
            ok: false,
            problem: `${label} records run creation before durable worktree readiness`,
          };
        }
        if (event.payload.route === 'run-created' && guidanceFrozen === null) {
          return {
            ok: false,
            problem: `${label} records run creation before durable frozen guidance`,
          };
        }
        const problem = verifyTransitionPayload(event.payload, state, checkpoint);
        if (problem !== null) {
          return { ok: false, problem: `${label}: ${problem}` };
        }
        state = event.payload.to;
        checkpoint = event.payload.checkpoint;
        if (event.payload.route === 'review-approved') {
          changedResultApproved = true;
        }
        break;
      }
      case 'workflow-attempt': {
        if (event.payload.sequence !== attempts.length + 1) {
          return {
            ok: false,
            problem: `${label} has attempt sequence ${event.payload.sequence} instead of ${attempts.length + 1}`,
          };
        }
        if (event.payload.state !== state) {
          return { ok: false, problem: `${label} records an attempt outside the recorded state` };
        }
        if (state === null || !isActiveWorkflowState(state)) {
          return { ok: false, problem: `${label} records an attempt while no stage is active` };
        }
        const attempt: WorkflowAttempt = {
          sequence: event.payload.sequence,
          kind: event.payload.kind,
          role: event.payload.role,
          state: event.payload.state,
          reason: event.payload.reason,
        };
        attempts.push(attempt);
        break;
      }
      case 'cleanup-progress': {
        cleanupProgress = event.payload;
        break;
      }
      case 'role-session-created': {
        const { role, attempt, generation, sessionId, ownershipToken } = event.payload;
        if (roleSessions.has(sessionId)) {
          return { ok: false, problem: `${label} reuses the role session "${sessionId}"` };
        }
        for (const existing of roleSessions.values()) {
          if (existing.state.role === role && existing.state.attempt === attempt) {
            return {
              ok: false,
              problem: `${label} starts a second session for role "${role}" attempt ${attempt}`,
            };
          }
        }
        roleSessions.set(sessionId, {
          state: {
            role,
            attempt,
            generation,
            sessionId,
            ownershipToken,
            initialSequence: event.payload.sequence,
            runtimeIdentity: event.payload.runtimeIdentity,
            workingDirectory: event.payload.workingDirectory,
            submission: null,
            submissionStarted: null,
            lastObservation: null,
            stopDisposition: null,
          },
          submissions: [],
          startedIdempotencyKeys: new Set(),
          pendingIdempotencyKey: null,
          awaitingObservation: false,
          expectedRepairNarrativeHash: null,
        });
        break;
      }
      case 'role-session-submission-requested': {
        const session = roleSessions.get(event.payload.sessionId);
        if (session === undefined) {
          return {
            ok: false,
            problem: `${label} submits a role turn for an unknown session "${event.payload.sessionId}"`,
          };
        }
        if (session.state.generation !== event.payload.generation) {
          return {
            ok: false,
            problem: `${label} records a submission generation that differs from its session`,
          };
        }
        const kind = event.payload.kind ?? 'initial';
        if (kind === 'initial') {
          if (session.submissions.length > 0) {
            return { ok: false, problem: `${label} records a second submission intent` };
          }
        } else {
          if (session.submissions.length === 0) {
            return {
              ok: false,
              problem: `${label} records a repair submission before any initial submission`,
            };
          }
          const observation = session.state.lastObservation;
          if (
            observation === null ||
            observation.status !== 'settled' ||
            observation.narrative === null
          ) {
            return {
              ok: false,
              problem: `${label} records a repair submission without a settled rejected report`,
            };
          }
          const repair = event.payload.repair ?? null;
          if (repair === null) {
            return {
              ok: false,
              problem: `${label} records a repair submission without the rejected envelope context`,
            };
          }
          if (repair.rejectedSequence !== observation.sequence) {
            return {
              ok: false,
              problem: `${label} records a repair for a different rejected sequence`,
            };
          }
          if (repair.rejectedNarrativeHash !== hashUtf8(observation.narrative)) {
            return {
              ok: false,
              problem: `${label} records a repair that does not preserve the rejected narrative`,
            };
          }
          if (observation.control === null) {
            if (repair.rejectedControl !== null || repair.rejectedControlHash !== null) {
              return {
                ok: false,
                problem: `${label} records a rejected control that the session never produced`,
              };
            }
          } else if (
            repair.rejectedControl === null ||
            repair.rejectedControlHash !== hashControl(observation.control)
          ) {
            return {
              ok: false,
              problem: `${label} records a repair that does not preserve the rejected control`,
            };
          }
          session.expectedRepairNarrativeHash = repair.rejectedNarrativeHash;
        }
        if (
          session.submissions.some((entry) => entry.idempotencyKey === event.payload.idempotencyKey)
        ) {
          return { ok: false, problem: `${label} reuses the recorded idempotency key` };
        }
        if (session.pendingIdempotencyKey !== null) {
          return {
            ok: false,
            problem: `${label} records a submission intent before the prior submission started`,
          };
        }
        if (event.payload.baselineSequence < session.state.initialSequence) {
          return {
            ok: false,
            problem: `${label} records a submission baseline older than the session sequence`,
          };
        }
        const priorSequence =
          session.state.lastObservation?.sequence ?? session.state.initialSequence;
        if (event.payload.baselineSequence < priorSequence) {
          return {
            ok: false,
            problem: `${label} records a submission baseline older than the last observed sequence`,
          };
        }
        session.submissions.push({
          kind,
          idempotencyKey: event.payload.idempotencyKey,
        });
        session.pendingIdempotencyKey = event.payload.idempotencyKey;
        session.state = {
          ...session.state,
          submission: {
            idempotencyKey: event.payload.idempotencyKey,
            promptHash: event.payload.promptHash,
            baselineSequence: event.payload.baselineSequence,
          },
        };
        break;
      }
      case 'role-session-submission-started': {
        const session = roleSessions.get(event.payload.sessionId);
        if (session === undefined) {
          return {
            ok: false,
            problem: `${label} starts a submission for an unknown session "${event.payload.sessionId}"`,
          };
        }
        if (session.state.generation !== event.payload.generation) {
          return {
            ok: false,
            problem: `${label} records a submission generation that differs from its session`,
          };
        }
        if (session.pendingIdempotencyKey === null || session.state.submission === null) {
          return { ok: false, problem: `${label} starts a submission before recording its intent` };
        }
        if (session.pendingIdempotencyKey !== event.payload.idempotencyKey) {
          return { ok: false, problem: `${label} changes the recorded idempotency key` };
        }
        if (session.startedIdempotencyKeys.has(event.payload.idempotencyKey)) {
          return { ok: false, problem: `${label} records a second submission start` };
        }
        session.startedIdempotencyKeys.add(event.payload.idempotencyKey);
        session.pendingIdempotencyKey = null;
        session.awaitingObservation = true;
        session.state = { ...session.state, submissionStarted: event.payload.submission };
        break;
      }
      case 'role-session-observed': {
        const session = roleSessions.get(event.payload.sessionId);
        if (session === undefined) {
          return {
            ok: false,
            problem: `${label} observes an unknown session "${event.payload.sessionId}"`,
          };
        }
        if (session.state.generation !== event.payload.generation) {
          return {
            ok: false,
            problem: `${label} records an observation generation that differs from its session`,
          };
        }
        const previousObservation = session.state.lastObservation;
        const pendingRepair = pendingControlRepairs.get(event.payload.sessionId);
        const repairPending = pendingRepair !== undefined && pendingRepair.phase === 'started';
        const becameTerminal =
          previousObservation !== null &&
          (previousObservation.status === 'settled' || previousObservation.status === 'lost');
        if (becameTerminal && !session.awaitingObservation && !repairPending) {
          return { ok: false, problem: `${label} observes a session after it became terminal` };
        }
        const baseline = repairPending
          ? pendingRepair.baselineSequence
          : (session.state.submission?.baselineSequence ?? session.state.initialSequence);
        if (event.payload.sequence < baseline) {
          return { ok: false, problem: `${label} regresses the observed session sequence` };
        }
        if (previousObservation !== null && event.payload.sequence < previousObservation.sequence) {
          return { ok: false, problem: `${label} regresses the observed session sequence` };
        }
        if (
          event.payload.status === 'settled' &&
          event.payload.sequence <= (previousObservation?.sequence ?? baseline)
        ) {
          return {
            ok: false,
            problem: `${label} records a settled observation that does not advance the sequence`,
          };
        }
        if (event.payload.status === 'settled') {
          if (event.payload.narrative === null || event.payload.narrative.trim().length === 0) {
            return {
              ok: false,
              problem: `${label} records a settled observation without a narrative`,
            };
          }
          if (event.payload.control === null) {
            return {
              ok: false,
              problem: `${label} records a settled observation without a control envelope`,
            };
          }
          if (
            session.expectedRepairNarrativeHash !== null &&
            hashUtf8(event.payload.narrative) !== session.expectedRepairNarrativeHash
          ) {
            return {
              ok: false,
              problem: `${label} records a repair that changed the original narrative`,
            };
          }
          session.expectedRepairNarrativeHash = null;
          session.awaitingObservation = false;
          if (repairPending && sha256Hex(event.payload.narrative) !== pendingRepair.narrativeHash) {
            return {
              ok: false,
              problem: `${label} records a control repair that changed the settled narrative`,
            };
          }
        } else if (event.payload.narrative !== null || event.payload.control !== null) {
          return {
            ok: false,
            problem: `${label} records an unfinished observation with a settled result`,
          };
        }
        session.state = {
          ...session.state,
          lastObservation: {
            status: event.payload.status,
            sequence: event.payload.sequence,
            eventCount: event.payload.eventCount,
            narrative: event.payload.narrative,
            control: event.payload.control,
          },
        };
        if (repairPending) {
          roleControlRepairs.push({
            sessionId: pendingRepair.sessionId,
            generation: pendingRepair.generation,
            sequence: pendingRepair.sequence,
            narrativeHash: pendingRepair.narrativeHash,
            controlHash: pendingRepair.controlHash,
            problem: pendingRepair.problem,
            idempotencyKey: pendingRepair.idempotencyKey,
            promptHash: pendingRepair.promptHash,
            baselineSequence: pendingRepair.baselineSequence,
            submission: pendingRepair.submission,
            observation: {
              status: event.payload.status,
              sequence: event.payload.sequence,
              eventCount: event.payload.eventCount,
              narrative: event.payload.narrative,
              control: event.payload.control,
            },
          });
          pendingControlRepairs.delete(event.payload.sessionId);
        }
        break;
      }
      case 'role-control-rejected': {
        const session = roleSessions.get(event.payload.sessionId);
        if (session === undefined) {
          return {
            ok: false,
            problem: `${label} rejects a control for an unknown session "${event.payload.sessionId}"`,
          };
        }
        if (session.state.generation !== event.payload.generation) {
          return {
            ok: false,
            problem: `${label} records a rejection generation that differs from its session`,
          };
        }
        if (pendingControlRepairs.has(event.payload.sessionId)) {
          return {
            ok: false,
            problem: `${label} records a control rejection while a repair is already pending`,
          };
        }
        const observation = session.state.lastObservation;
        if (observation === null || observation.status !== 'settled') {
          return {
            ok: false,
            problem: `${label} rejects a control without a settled observation`,
          };
        }
        if (observation.sequence !== event.payload.sequence || observation.narrative === null) {
          return {
            ok: false,
            problem: `${label} rejects a control for a different settled observation`,
          };
        }
        if (sha256Hex(observation.narrative) !== event.payload.narrativeHash) {
          return {
            ok: false,
            problem: `${label} records a narrative hash that does not match the settled narrative`,
          };
        }
        pendingControlRepairs.set(event.payload.sessionId, {
          sessionId: event.payload.sessionId,
          generation: event.payload.generation,
          sequence: event.payload.sequence,
          narrativeHash: event.payload.narrativeHash,
          controlHash: event.payload.controlHash,
          problem: event.payload.problem,
          idempotencyKey: '',
          promptHash: '',
          baselineSequence: event.payload.sequence,
          submission: null,
          observation: null,
          phase: 'rejected',
        });
        break;
      }
      case 'role-control-repair-requested': {
        const pending = pendingControlRepairs.get(event.payload.sessionId);
        if (pending === undefined) {
          return {
            ok: false,
            problem: `${label} requests a control repair without a recorded rejection`,
          };
        }
        if (pending.generation !== event.payload.generation) {
          return {
            ok: false,
            problem: `${label} records a repair generation that differs from its rejection`,
          };
        }
        if (pending.phase !== 'rejected') {
          return { ok: false, problem: `${label} records a second control repair request` };
        }
        if (event.payload.baselineSequence < pending.sequence) {
          return {
            ok: false,
            problem: `${label} records a repair baseline older than the rejected observation`,
          };
        }
        if (event.payload.problem !== pending.problem) {
          return {
            ok: false,
            problem: `${label} records a repair request that changes the rejection problem`,
          };
        }
        pending.phase = 'requested';
        pending.idempotencyKey = event.payload.idempotencyKey;
        pending.promptHash = event.payload.promptHash;
        pending.baselineSequence = event.payload.baselineSequence;
        break;
      }
      case 'role-control-repair-started': {
        const pending = pendingControlRepairs.get(event.payload.sessionId);
        if (pending === undefined) {
          return {
            ok: false,
            problem: `${label} starts a control repair without a recorded request`,
          };
        }
        if (pending.generation !== event.payload.generation) {
          return {
            ok: false,
            problem: `${label} records a repair generation that differs from its request`,
          };
        }
        if (pending.phase !== 'requested') {
          return { ok: false, problem: `${label} records a second control repair submission` };
        }
        if (pending.idempotencyKey !== event.payload.idempotencyKey) {
          return { ok: false, problem: `${label} changes the recorded repair idempotency key` };
        }
        pending.phase = 'started';
        pending.submission = event.payload.submission;
        break;
      }
      case 'role-session-stopped': {
        const session = roleSessions.get(event.payload.sessionId);
        if (session === undefined) {
          return {
            ok: false,
            problem: `${label} stops an unknown session "${event.payload.sessionId}"`,
          };
        }
        if (session.state.generation !== event.payload.generation) {
          return {
            ok: false,
            problem: `${label} records a stop generation that differs from its session`,
          };
        }
        if (session.state.stopDisposition !== null) {
          return { ok: false, problem: `${label} records a second stop disposition` };
        }
        session.state = { ...session.state, stopDisposition: event.payload.disposition };
        break;
      }
      case 'plan-accepted': {
        if (state !== 'planning') {
          return {
            ok: false,
            problem: `${label} records an accepted plan outside the planning stage`,
          };
        }
        if (acceptedPlan !== null) {
          return { ok: false, problem: `${label} records a second accepted plan` };
        }
        if (event.payload.criteria.length < 1) {
          return { ok: false, problem: `${label} records an accepted plan without criteria` };
        }
        const objectiveCount = event.payload.execution.objectives.length;
        if (objectiveCount < 1) {
          return { ok: false, problem: `${label} records an accepted plan without objectives` };
        }
        if (event.payload.execution.mode === 'sequential' && objectiveCount !== 1) {
          return {
            ok: false,
            problem: `${label} records a sequential plan with ${objectiveCount} objectives`,
          };
        }
        acceptedPlan = event.payload;
        break;
      }
      case 'finding-recorded': {
        const resultCommit = currentResultCommit();
        if (resultCommit === null) {
          return {
            ok: false,
            problem: `${label} records a finding without an accepted implementation commit`,
          };
        }
        if (event.payload.commit !== resultCommit) {
          return {
            ok: false,
            problem: `${label} records a finding for a commit other than the current result head`,
          };
        }
        if (
          findings.some(
            (finding) => finding.commit === event.payload.commit && finding.id === event.payload.id,
          )
        ) {
          return {
            ok: false,
            problem: `${label} reuses the finding id "${event.payload.id}" for ${event.payload.commit}`,
          };
        }
        findings.push(event.payload);
        break;
      }
      case 'role-permission-violation': {
        permissionViolations.push(event.payload);
        break;
      }
      case 'implementation-accepted': {
        if (worktreeReady === null) {
          return {
            ok: false,
            problem: `${label} records an accepted implementation before durable worktree readiness`,
          };
        }
        if (
          event.payload.taskBranch !== worktreeReady.taskBranch ||
          event.payload.baseCommit !== worktreeReady.baseCommit
        ) {
          return {
            ok: false,
            problem: `${label} records an implementation that differs from the frozen worktree identity`,
          };
        }
        if (event.payload.noChangeCandidate) {
          if (event.payload.commit !== null) {
            return {
              ok: false,
              problem: `${label} records a no-change candidate with an implementation commit`,
            };
          }
        } else if (
          event.payload.commit === null ||
          event.payload.commit === event.payload.baseCommit
        ) {
          return {
            ok: false,
            problem: `${label} records an implementation without a new Git-derived commit`,
          };
        }
        if (
          implementation !== null &&
          implementation.commit !== null &&
          implementation.commit === event.payload.commit
        ) {
          return {
            ok: false,
            problem: `${label} re-accepts the same implementation commit`,
          };
        }
        implementation = event.payload;
        break;
      }
      case 'verification-completed': {
        if (state !== 'verifying') {
          return {
            ok: false,
            problem: `${label} records a verification report outside the verifying stage`,
          };
        }
        const resultCommit = currentResultCommit();
        if (resultCommit === null) {
          return {
            ok: false,
            problem: `${label} records a verification report without an accepted implementation`,
          };
        }
        if (event.payload.commit !== resultCommit) {
          return {
            ok: false,
            problem: `${label} records a verification report for a different commit`,
          };
        }
        if (event.payload.executions.length < 1) {
          return {
            ok: false,
            problem: `${label} records a verification report without executions`,
          };
        }
        verifications.push(event.payload);
        break;
      }
      case 'tester-skipped': {
        if (state !== 'verifying') {
          return {
            ok: false,
            problem: `${label} records a Tester skip outside the verifying stage`,
          };
        }
        if (acceptedPlan === null || acceptedPlan.runtimeValidationRequired) {
          return {
            ok: false,
            problem: `${label} records a Tester skip for a plan that requires runtime validation`,
          };
        }
        const resultCommit = currentResultCommit();
        if (resultCommit === null || event.payload.verificationCommit !== resultCommit) {
          return {
            ok: false,
            problem: `${label} records a Tester skip without a commit-bound verification report`,
          };
        }
        if (!verifications.some((report) => report.commit === resultCommit)) {
          return {
            ok: false,
            problem: `${label} records a Tester skip before the commit-bound verification report`,
          };
        }
        testerSkips.push(event.payload);
        break;
      }
      case 'validation-limitation': {
        if (state !== 'verifying' && state !== 'testing') {
          return {
            ok: false,
            problem: `${label} records a validation limitation outside validation routing`,
          };
        }
        if (acceptedPlan === null || !acceptedPlan.runtimeValidationRequired) {
          return {
            ok: false,
            problem: `${label} records a validation limitation when the plan does not require it`,
          };
        }
        const resultCommit = currentResultCommit();
        if (resultCommit === null || event.payload.commit !== resultCommit) {
          return {
            ok: false,
            problem: `${label} records a validation limitation for a different commit`,
          };
        }
        validationLimitations.push(event.payload);
        break;
      }
      case 'runtime-lifecycle': {
        if (state !== 'verifying' && state !== 'testing') {
          return {
            ok: false,
            problem: `${label} records a runtime lifecycle outside runtime preparation`,
          };
        }
        if (acceptedPlan === null || !acceptedPlan.runtimeValidationRequired) {
          return {
            ok: false,
            problem: `${label} records a runtime lifecycle when the plan does not require it`,
          };
        }
        const resultCommit = currentResultCommit();
        if (resultCommit === null || event.payload.commit !== resultCommit) {
          return {
            ok: false,
            problem: `${label} records a runtime lifecycle for a different commit`,
          };
        }
        runtimeLifecycles.push(event.payload);
        break;
      }
      case 'decision-opened': {
        if (state !== 'publishing') {
          return {
            ok: false,
            problem: `${label} records an opened decision outside the publishing stage`,
          };
        }
        const resultCommit = currentResultCommit();
        if (resultCommit === null || event.payload.resultCommit !== resultCommit) {
          return {
            ok: false,
            problem: `${label} opens a decision for a commit other than the current result head`,
          };
        }
        if (event.payload.options.length < 2) {
          return {
            ok: false,
            problem: `${label} records a decision with fewer than two labelled options`,
          };
        }
        if (openedDecisionIds.has(event.payload.decisionId)) {
          return { ok: false, problem: `${label} re-opens a decision id for this run` };
        }
        if (decisionOpened !== null && decisionOpened.resultCommit === event.payload.resultCommit) {
          return {
            ok: false,
            problem: `${label} opens a second decision for the same result head`,
          };
        }
        openedDecisionIds.add(event.payload.decisionId);
        decisionOpened = event.payload;
        decisionApplied = null;
        lastPublicationCheckpoint = null;
        break;
      }
      case 'publication-checkpoint': {
        if (state !== 'publishing') {
          return {
            ok: false,
            problem: `${label} records a publication checkpoint outside the publishing stage`,
          };
        }
        if (decisionOpened === null || event.payload.decisionId !== decisionOpened.decisionId) {
          return {
            ok: false,
            problem: `${label} records a publication checkpoint for an unopened decision`,
          };
        }
        const stageIndex = PUBLICATION_CHECKPOINT_STAGES.indexOf(event.payload.stage);
        const previousIndex =
          lastPublicationCheckpoint === null
            ? -1
            : PUBLICATION_CHECKPOINT_STAGES.indexOf(lastPublicationCheckpoint);
        if (stageIndex <= previousIndex) {
          return {
            ok: false,
            problem: `${label} records an out-of-order publication checkpoint`,
          };
        }
        if (event.payload.stage !== 'url-recorded' && event.payload.draftPrUrl !== null) {
          return {
            ok: false,
            problem: `${label} records a draft PR URL before the url-recorded checkpoint`,
          };
        }
        lastPublicationCheckpoint = event.payload.stage;
        break;
      }
      case 'objective-worker': {
        if (state !== 'coding' && state !== 'correcting') {
          return {
            ok: false,
            problem: `${label} records an objective worker outside the coding stage`,
          };
        }
        const { objectiveId, attempt, phase } = event.payload;
        const created = objectiveWorkers.some(
          (worker) =>
            worker.objectiveId === objectiveId &&
            worker.attempt === attempt &&
            worker.phase === 'created',
        );
        const settled = objectiveWorkers.some(
          (worker) =>
            worker.objectiveId === objectiveId &&
            worker.attempt === attempt &&
            worker.phase === 'settled',
        );
        const disposed = objectiveWorkers.some(
          (worker) => worker.objectiveId === objectiveId && worker.phase === 'disposed',
        );
        if (phase === 'created') {
          if (created) {
            return {
              ok: false,
              problem: `${label} re-creates objective worker "${objectiveId}" attempt ${attempt}`,
            };
          }
          if (disposed) {
            return {
              ok: false,
              problem: `${label} creates objective worker "${objectiveId}" after its disposal`,
            };
          }
        } else if (phase === 'settled') {
          if (!created) {
            return {
              ok: false,
              problem: `${label} settles objective worker "${objectiveId}" attempt ${attempt} without a recorded creation`,
            };
          }
          if (settled) {
            return {
              ok: false,
              problem: `${label} settles objective worker "${objectiveId}" attempt ${attempt} twice`,
            };
          }
        } else {
          if (!created) {
            return {
              ok: false,
              problem: `${label} disposes objective worker "${objectiveId}" before its creation`,
            };
          }
          if (disposed) {
            return {
              ok: false,
              problem: `${label} disposes objective worker "${objectiveId}" twice`,
            };
          }
        }
        objectiveWorkers.push(event.payload);
        break;
      }
      case 'evidence-invalidated': {
        const { retiredKinds, retiredCommit, retiredRevision } = event.payload;
        if (retiredRevision > events.length) {
          return {
            ok: false,
            problem: `${label} retires the future revision ${retiredRevision}`,
          };
        }
        const retired = events[retiredRevision - 1];
        if (retired === undefined) {
          return {
            ok: false,
            problem: `${label} retires a revision that is not in the history`,
          };
        }
        if (retiredKinds === 'verification') {
          if (
            retired.type !== 'verification-completed' ||
            retired.payload.commit !== retiredCommit
          ) {
            return {
              ok: false,
              problem: `${label} retires a revision that is not the named verification`,
            };
          }
        } else if (retired.type !== 'evidence-bound' || retired.payload.commit !== retiredCommit) {
          return {
            ok: false,
            problem: `${label} retires a revision that is not the named Tester observation`,
          };
        }
        const resultCommit = currentResultCommit();
        if (resultCommit !== null && retiredCommit === resultCommit) {
          return {
            ok: false,
            problem: `${label} retires evidence bound to the current result head`,
          };
        }
        if (retiredRevisions.has(retiredRevision)) {
          return {
            ok: false,
            problem: `${label} retires a revision that was already retired`,
          };
        }
        retiredRevisions.add(retiredRevision);
        evidenceInvalidations.push(event.payload);
        break;
      }
      case 'evidence-bound': {
        const session = roleSessions.get(event.payload.sessionId);
        if (session === undefined || session.state.role !== 'tester') {
          return {
            ok: false,
            problem: `${label} binds a Tester observation to an unknown Tester session "${event.payload.sessionId}"`,
          };
        }
        const resultCommit = currentResultCommit();
        if (resultCommit === null || event.payload.commit !== resultCommit) {
          return {
            ok: false,
            problem: `${label} binds a Tester observation to a commit other than the current result head`,
          };
        }
        evidenceBindings.push(event.payload);
        break;
      }
      case 'decision-applied': {
        if (state !== 'human_decision_required') {
          return {
            ok: false,
            problem: `${label} applies a human decision outside the waiting state`,
          };
        }
        if (decisionOpened === null || event.payload.decisionId !== decisionOpened.decisionId) {
          return {
            ok: false,
            problem: `${label} applies a decision that is not the open decision`,
          };
        }
        const option = decisionOpened.options.find(
          (candidate) => candidate.id === event.payload.optionId,
        );
        if (option === undefined) {
          return { ok: false, problem: `${label} applies an unknown decision option` };
        }
        if (option.action !== event.payload.action) {
          return {
            ok: false,
            problem: `${label} records an action that differs from the labelled decision option`,
          };
        }
        if (decisionApplied !== null) {
          return {
            ok: false,
            problem: `${label} applies a second decision to the same opened decision`,
          };
        }
        decisionApplied = event.payload;
        decisionApplieds.push(event.payload);
        break;
      }
      case 'publication-reconciled': {
        if (state !== 'publishing') {
          return {
            ok: false,
            problem: `${label} records a reconciled publication outside the publishing stage`,
          };
        }
        if (lastPublicationCheckpoint !== 'url-recorded') {
          return {
            ok: false,
            problem: `${label} records a reconciled publication before the exact draft URL is durable`,
          };
        }
        if (decisionOpened === null) {
          return {
            ok: false,
            problem: `${label} records a reconciled publication for an unopened decision`,
          };
        }
        break;
      }
      case 'integration-declared': {
        if (state !== 'coding' && state !== 'correcting') {
          return {
            ok: false,
            problem: `${label} records an integration declaration outside the coding stage`,
          };
        }
        if (integrationDeclared !== null) {
          return { ok: false, problem: `${label} records a second integration declaration` };
        }
        const declared = event.payload;
        if (declared.objectiveIds.length < 2) {
          return {
            ok: false,
            problem: `${label} declares integration for fewer than two objectives`,
          };
        }
        if (
          declared.commits.length !== declared.objectiveIds.length ||
          declared.declaredOrder.length !== declared.objectiveIds.length
        ) {
          return {
            ok: false,
            problem: `${label} declares an integration set with mismatched lengths`,
          };
        }
        const declaredObjectives = new Set(declared.objectiveIds);
        if (declaredObjectives.size !== declared.objectiveIds.length) {
          return { ok: false, problem: `${label} declares duplicate objective ids` };
        }
        if (
          new Set(declared.declaredOrder).size !== declared.declaredOrder.length ||
          !declared.declaredOrder.every((objectiveId) => declaredObjectives.has(objectiveId))
        ) {
          return {
            ok: false,
            problem: `${label} declares an integration order that is not a permutation of the objective set`,
          };
        }
        for (const [index, objectiveId] of declared.objectiveIds.entries()) {
          const commit = declared.commits[index];
          const settled = objectiveWorkers.some(
            (worker) =>
              worker.objectiveId === objectiveId &&
              worker.phase === 'settled' &&
              worker.commit !== null &&
              worker.commit === commit,
          );
          if (!settled) {
            return {
              ok: false,
              problem: `${label} declares objective "${objectiveId}" without a matching settled worker commit`,
            };
          }
        }
        integrationDeclared = declared;
        break;
      }
      case 'integration-completed': {
        if (integrationDeclared === null) {
          return {
            ok: false,
            problem: `${label} completes integration without a declaration`,
          };
        }
        if (integrationCompleted !== null) {
          return { ok: false, problem: `${label} records a second integration completion` };
        }
        if (state !== 'verifying') {
          return {
            ok: false,
            problem: `${label} completes integration outside the verifying stage`,
          };
        }
        const completion = event.payload;
        const declaredObjectives = new Set(integrationDeclared.objectiveIds);
        if (
          completion.actualOrder.length !== integrationDeclared.objectiveIds.length ||
          new Set(completion.actualOrder).size !== completion.actualOrder.length ||
          !completion.actualOrder.every((objectiveId) => declaredObjectives.has(objectiveId))
        ) {
          return {
            ok: false,
            problem: `${label} records an actual order that is not a permutation of the declared objective set`,
          };
        }
        const resultCommit = currentResultCommit();
        if (resultCommit === null || completion.aggregateCommit !== resultCommit) {
          return {
            ok: false,
            problem: `${label} completes integration for a commit other than the current result head`,
          };
        }
        integrationCompleted = completion;
        break;
      }
      case 'evidence-manifest': {
        if (state !== 'testing') {
          return {
            ok: false,
            problem: `${label} records a Tester evidence manifest outside the testing stage`,
          };
        }
        if (acceptedPlan !== null) {
          const knownCriterionIds = new Set(acceptedPlan.criteria.map((criterion) => criterion.id));
          for (const entry of event.payload.entries) {
            for (const criterionId of entry.criterionIds) {
              if (!knownCriterionIds.has(criterionId)) {
                return {
                  ok: false,
                  problem: `${label} links a Tester evidence manifest entry to the unknown criterion "${criterionId}"`,
                };
              }
            }
          }
        }
        evidenceManifests.push(event.payload);
        break;
      }
      case 'recovery-recorded': {
        if (state === null || isTerminalWorkflowState(state)) {
          return {
            ok: false,
            problem: `${label} records a recovery disposition for a terminal or unstarted run`,
          };
        }
        recoveryDispositions.push(event.payload);
        break;
      }
      case 'result-pr-checkpoint': {
        if (state !== 'completed' || !changedResultApproved) {
          return {
            ok: false,
            problem: `${label} records a result publication checkpoint outside an approved changed result`,
          };
        }
        const resultCommit = currentResultCommit();
        if (resultCommit === null || event.payload.commit !== resultCommit) {
          return {
            ok: false,
            problem: `${label} records a result publication checkpoint for a commit other than the current result head`,
          };
        }
        const stageIndex = RESULT_PUBLICATION_CHECKPOINT_STAGES.indexOf(event.payload.stage);
        const previousIndex = resultPrCheckpointStageIndex.get(event.payload.commit) ?? -1;
        if (stageIndex <= previousIndex) {
          return {
            ok: false,
            problem: `${label} records an out-of-order result publication checkpoint`,
          };
        }
        if (event.payload.stage !== 'url-recorded' && event.payload.url !== null) {
          return {
            ok: false,
            problem: `${label} records a result pull request URL before the url-recorded checkpoint`,
          };
        }
        resultPrCheckpointStageIndex.set(event.payload.commit, stageIndex);
        resultPrCheckpoints.push(event.payload);
        break;
      }
      case 'result-pr-recorded': {
        if (state !== 'completed' || !changedResultApproved) {
          return {
            ok: false,
            problem: `${label} records a result pull request outside an approved changed result`,
          };
        }
        const resultCommit = currentResultCommit();
        if (resultCommit === null || event.payload.commit !== resultCommit) {
          return {
            ok: false,
            problem: `${label} records a result pull request for a commit other than the current result head`,
          };
        }
        if (sourceFrozen !== null && event.payload.taskBranch !== sourceFrozen.taskBranch) {
          return {
            ok: false,
            problem: `${label} records a result pull request for a branch other than the frozen task branch`,
          };
        }
        const recordedUrl = [...resultPrCheckpoints]
          .reverse()
          .find(
            (checkpoint) =>
              checkpoint.stage === 'url-recorded' && checkpoint.commit === event.payload.commit,
          )?.url;
        if (recordedUrl === undefined || recordedUrl === null) {
          return {
            ok: false,
            problem: `${label} records a result pull request before the exact URL is durable`,
          };
        }
        if (recordedUrl !== event.payload.url) {
          return {
            ok: false,
            problem: `${label} records a result pull request URL that differs from its url-recorded checkpoint`,
          };
        }
        if (recordedResultPrCommits.has(event.payload.commit)) {
          return {
            ok: false,
            problem: `${label} records a second result pull request for the same commit`,
          };
        }
        if (resultMergeRecorded !== null && resultMergeRecorded.commit === event.payload.commit) {
          return {
            ok: false,
            problem: `${label} records a result pull request after a direct merge of the same commit`,
          };
        }
        recordedResultPrCommits.add(event.payload.commit);
        resultPrRecorded = event.payload;
        break;
      }
      case 'result-merge-recorded': {
        if (state !== 'completed' || !changedResultApproved) {
          return {
            ok: false,
            problem: `${label} records a direct merge outside an approved changed result`,
          };
        }
        const resultCommit = currentResultCommit();
        if (resultCommit === null || event.payload.commit !== resultCommit) {
          return {
            ok: false,
            problem: `${label} records a direct merge for a commit other than the current result head`,
          };
        }
        if (sourceFrozen !== null) {
          if (event.payload.taskBranch !== sourceFrozen.taskBranch) {
            return {
              ok: false,
              problem: `${label} records a direct merge for a branch other than the frozen task branch`,
            };
          }
          if (event.payload.remote !== sourceFrozen.sourceRemote) {
            return {
              ok: false,
              problem: `${label} records a direct merge through a remote other than the frozen source remote`,
            };
          }
          if (event.payload.sourceBranch !== sourceFrozen.sourceBranch) {
            return {
              ok: false,
              problem: `${label} records a direct merge into a branch other than the frozen source branch`,
            };
          }
        }
        if (
          resultPrCheckpoints.some(
            (checkpoint) =>
              checkpoint.commit === event.payload.commit &&
              RESULT_PULL_REQUEST_CHECKPOINT_STAGES.has(checkpoint.stage),
          )
        ) {
          return {
            ok: false,
            problem: `${label} records a direct merge after a result pull request attempt for the same commit`,
          };
        }
        if (recordedResultPrCommits.has(event.payload.commit)) {
          return {
            ok: false,
            problem: `${label} records a direct merge for a commit that already has a result pull request`,
          };
        }
        if (recordedResultMergeCommits.has(event.payload.commit)) {
          return {
            ok: false,
            problem: `${label} records a second direct merge for the same commit`,
          };
        }
        recordedResultMergeCommits.add(event.payload.commit);
        resultMergeRecorded = event.payload;
        break;
      }
      case 'abandonment-note': {
        /*
         * Unlike `recovery-recorded`, which refuses terminal states, the
         * abandonment note is recorded after the run is already terminal
         * `abandoned`; that asymmetry is intended. The note is the durable
         * operator reason for the explicit abandonment.
         */
        if (state !== 'abandoned') {
          return {
            ok: false,
            problem: `${label} records an abandonment reason outside the abandoned state`,
          };
        }
        abandonmentNotes.push(event.payload);
        break;
      }
    }
    previousHash = event.eventHash;
  }

  return {
    ok: true,
    head: { revision: events.length, eventHash: previousHash },
    derived: {
      state,
      checkpoint,
      attempts,
      cleanupProgress,
      sourceFrozen,
      guidanceFrozen,
      worktreeReady,
      roleSessions: [...roleSessions.values()].map((session) => session.state),
      roleControlRepairs: [
        ...roleControlRepairs,
        ...[...pendingControlRepairs.values()].map((pending) => ({
          sessionId: pending.sessionId,
          generation: pending.generation,
          sequence: pending.sequence,
          narrativeHash: pending.narrativeHash,
          controlHash: pending.controlHash,
          problem: pending.problem,
          idempotencyKey: pending.idempotencyKey,
          promptHash: pending.promptHash,
          baselineSequence: pending.baselineSequence,
          submission: pending.submission,
          observation: pending.observation,
        })),
      ],
      acceptedPlan,
      findings,
      implementation,
      permissionViolations,
      verifications,
      testerSkips,
      validationLimitations,
      runtimeLifecycles,
      objectiveWorkers,
      evidenceInvalidations,
      evidenceBindings,
      decisionApplieds,
      integrationDeclared,
      integrationCompleted,
      evidenceManifests,
      recoveryDispositions,
      resultPrCheckpoints,
      resultPrRecorded,
      resultMergeRecorded,
      abandonmentNotes,
    },
  };
}
