import { Schema } from 'effect';

import { FindingRecordSchema } from './findings.js';
import { REVIEWER_DECISION_ACTIONS, REVIEWER_TURN_OUTCOMES } from './reviewer-outcomes.js';
import { GitCommitId } from './run-locations.js';
import {
  PlanAcceptedObjectiveSchema,
  RolePermissionViolationPayloadSchema,
  UtcInstant,
} from './run-history.js';
import {
  WORKFLOW_TRANSITION_ROUTE_KINDS,
  WorkflowAttemptSchema,
  WorkflowStateSchema,
} from './workflow.js';

export const RUN_INSPECT_REPORT_SCHEMA_VERSION = 1 as const;

/**
 * How a report section stands relative to the verified history. `available`
 * means records exist and are summarized; `empty-not-proven` means no records
 * were found and their absence must never be presented as proof that nothing
 * happened; `unavailable` means records are expected but the summary could not
 * be produced, so a reader must not read the empty section as "none".
 */
export const INSPECT_AVAILABILITIES = ['available', 'empty-not-proven', 'unavailable'] as const;

export type InspectAvailability = (typeof INSPECT_AVAILABILITIES)[number];

export const InspectAvailabilitySchema = Schema.Literals(INSPECT_AVAILABILITIES);

export const InspectAvailabilityEntrySchema = Schema.Struct({
  availability: InspectAvailabilitySchema,
  detail: Schema.NonEmptyString,
});

export type InspectAvailabilityEntry = (typeof InspectAvailabilityEntrySchema)['Type'];

export const InspectSectionsSchema = Schema.Struct({
  plan: InspectAvailabilityEntrySchema,
  implementation: InspectAvailabilityEntrySchema,
  checks: InspectAvailabilityEntrySchema,
  tester: InspectAvailabilityEntrySchema,
  reviewer: InspectAvailabilityEntrySchema,
  failures: InspectAvailabilityEntrySchema,
  findings: InspectAvailabilityEntrySchema,
  corrections: InspectAvailabilityEntrySchema,
  decision: InspectAvailabilityEntrySchema,
  publication: InspectAvailabilityEntrySchema,
  journals: InspectAvailabilityEntrySchema,
  captures: InspectAvailabilityEntrySchema,
});

export type InspectSections = (typeof InspectSectionsSchema)['Type'];

export const InspectCheckExecutionSchema = Schema.Struct({
  kind: Schema.Literals(['bootstrap', 'gate']),
  name: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
  expectedExitCode: Schema.Int,
  actualExitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  passed: Schema.Boolean,
  logPath: Schema.NonEmptyString,
  logSha256: Schema.NonEmptyString,
  logByteLength: Schema.Natural,
  logRetainedByteLength: Schema.Natural,
  logTruncated: Schema.Boolean,
  logRedactionCount: Schema.Natural,
});

export type InspectCheckExecution = (typeof InspectCheckExecutionSchema)['Type'];

export const InspectCheckReportSchema = Schema.Struct({
  attempt: Schema.Int,
  commit: Schema.NonEmptyString,
  result: Schema.Literals(['passed', 'failed']),
  profileHash: Schema.NonEmptyString,
  commandMs: Schema.Int,
  executions: Schema.Array(InspectCheckExecutionSchema),
});

export type InspectCheckReport = (typeof InspectCheckReportSchema)['Type'];

export const InspectPlanCriterionSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  objectiveIds: Schema.Array(Schema.NonEmptyString),
  resultCommit: Schema.NullOr(Schema.NonEmptyString),
  checks: Schema.Array(Schema.NonEmptyString),
  reviewerOutcome: Schema.NullOr(Schema.Literals(REVIEWER_TURN_OUTCOMES)),
});

export type InspectPlanCriterion = (typeof InspectPlanCriterionSchema)['Type'];

export const InspectPlanSchema = Schema.Struct({
  outcome: Schema.Literals(['plan_ready', 'no_change_candidate']),
  runtimeValidationRequired: Schema.Boolean,
  executionMode: Schema.Literals(['sequential', 'parallel']),
  criteria: Schema.Array(InspectPlanCriterionSchema),
  objectives: Schema.Array(PlanAcceptedObjectiveSchema),
});

export type InspectPlan = (typeof InspectPlanSchema)['Type'];

export const InspectImplementationSchema = Schema.Struct({
  taskBranch: Schema.NonEmptyString,
  baseCommit: Schema.NonEmptyString,
  commit: Schema.NullOr(Schema.NonEmptyString),
  changedFiles: Schema.Array(Schema.NonEmptyString),
  noChangeCandidate: Schema.Boolean,
});

export type InspectImplementation = (typeof InspectImplementationSchema)['Type'];

export const InspectTesterLimitationSchema = Schema.Struct({
  reason: Schema.NonEmptyString,
  commit: GitCommitId,
});

export type InspectTesterLimitation = (typeof InspectTesterLimitationSchema)['Type'];

export const InspectTesterSkipSchema = Schema.Struct({
  reason: Schema.NonEmptyString,
  verificationCommit: GitCommitId,
});

export type InspectTesterSkip = (typeof InspectTesterSkipSchema)['Type'];

export const InspectTesterRuntimeSchema = Schema.Struct({
  commit: Schema.NonEmptyString,
  outcome: Schema.NonEmptyString,
  cleanup: Schema.NonEmptyString,
  dataPreserved: Schema.Boolean,
});

export type InspectTesterRuntime = (typeof InspectTesterRuntimeSchema)['Type'];

export const INSPECT_TESTER_STATUSES = ['observed', 'skipped', 'limitation', 'missing'] as const;

export const InspectTesterSchema = Schema.Struct({
  required: Schema.Boolean,
  status: Schema.Literals(INSPECT_TESTER_STATUSES),
  detail: Schema.NonEmptyString,
  commit: Schema.NullOr(Schema.NonEmptyString),
  narrative: Schema.NullOr(Schema.String),
  limitations: Schema.Array(InspectTesterLimitationSchema),
  skips: Schema.Array(InspectTesterSkipSchema),
  runtimes: Schema.Array(InspectTesterRuntimeSchema),
});

export type InspectTester = (typeof InspectTesterSchema)['Type'];

export const InspectReviewerSchema = Schema.Struct({
  outcome: Schema.NullOr(Schema.Literals(REVIEWER_TURN_OUTCOMES)),
  attempt: Schema.Int,
  narrative: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
});

export type InspectReviewer = (typeof InspectReviewerSchema)['Type'];

export const InspectControlRejectionSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: Schema.Int,
  sequence: Schema.Int,
  problem: Schema.NonEmptyString,
  resolved: Schema.Boolean,
});

export type InspectControlRejection = (typeof InspectControlRejectionSchema)['Type'];

export const InspectFailuresSchema = Schema.Struct({
  attempts: Schema.Array(WorkflowAttemptSchema),
  controlRejections: Schema.Array(InspectControlRejectionSchema),
  permissionViolations: Schema.Array(RolePermissionViolationPayloadSchema),
});

export type InspectFailures = (typeof InspectFailuresSchema)['Type'];

export const InspectCorrectionSchema = Schema.Struct({
  route: Schema.Literals(WORKFLOW_TRANSITION_ROUTE_KINDS),
  from: Schema.NullOr(WorkflowStateSchema),
  to: WorkflowStateSchema,
  at: UtcInstant,
});

export type InspectCorrection = (typeof InspectCorrectionSchema)['Type'];

export const InspectDecisionOptionSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  action: Schema.Literals(REVIEWER_DECISION_ACTIONS),
});

export type InspectDecisionOption = (typeof InspectDecisionOptionSchema)['Type'];

export const InspectDecisionCommandSchema = Schema.Struct({
  optionId: Schema.NonEmptyString,
  action: Schema.Literals(REVIEWER_DECISION_ACTIONS),
  command: Schema.NonEmptyString,
});

export type InspectDecisionCommand = (typeof InspectDecisionCommandSchema)['Type'];

export const InspectDecisionSchema = Schema.Struct({
  decisionId: Schema.NullOr(Schema.NonEmptyString),
  question: Schema.NonEmptyString,
  recommendation: Schema.NullOr(Schema.NonEmptyString),
  options: Schema.Array(InspectDecisionOptionSchema),
  commands: Schema.Array(InspectDecisionCommandSchema),
  commandsExact: Schema.Boolean,
  unresolvedFindings: Schema.Array(FindingRecordSchema),
  unresolvedLimitations: Schema.Array(InspectTesterLimitationSchema),
  sourceCommit: Schema.NullOr(Schema.NonEmptyString),
  resultCommit: Schema.NullOr(Schema.NonEmptyString),
  draftPrUrl: Schema.NullOr(Schema.NonEmptyString),
  publicationStage: Schema.NullOr(Schema.NonEmptyString),
  commentAccepted: Schema.Boolean,
  commentAcceptedKnown: Schema.Boolean,
});

export type InspectDecision = (typeof InspectDecisionSchema)['Type'];

export const InspectPublicationTransitionSchema = Schema.Struct({
  route: Schema.Literals(WORKFLOW_TRANSITION_ROUTE_KINDS),
  from: Schema.NullOr(WorkflowStateSchema),
  to: WorkflowStateSchema,
  at: UtcInstant,
});

export type InspectPublicationTransition = (typeof InspectPublicationTransitionSchema)['Type'];

export const InspectPublicationCheckpointSchema = Schema.Struct({
  stage: Schema.NonEmptyString,
  draftPrUrl: Schema.NullOr(Schema.String),
  decisionId: Schema.NullOr(Schema.String),
  detail: Schema.String,
});

export type InspectPublicationCheckpoint = (typeof InspectPublicationCheckpointSchema)['Type'];

export const InspectPublicationSchema = Schema.Struct({
  state: Schema.NullOr(WorkflowStateSchema),
  transitions: Schema.Array(InspectPublicationTransitionSchema),
  checkpoints: Schema.Array(InspectPublicationCheckpointSchema),
  draftPrUrl: Schema.NullOr(Schema.String),
});

export type InspectPublication = (typeof InspectPublicationSchema)['Type'];

export const INSPECT_JOURNAL_KINDS = [
  'submission-pending',
  'observation-awaiting',
  'control-repair-unresolved',
] as const;

export const InspectJournalSchema = Schema.Struct({
  kind: Schema.Literals(INSPECT_JOURNAL_KINDS),
  sessionId: Schema.NonEmptyString,
  role: Schema.NullOr(Schema.NonEmptyString),
  generation: Schema.NullOr(Schema.Int),
  detail: Schema.NonEmptyString,
});

export type InspectJournal = (typeof InspectJournalSchema)['Type'];

export const INSPECT_CAPTURE_SOURCES = [
  'verification-log',
  'tracked-mutation',
  'finding-evidence',
] as const;

export const InspectCaptureSchema = Schema.Struct({
  source: Schema.Literals(INSPECT_CAPTURE_SOURCES),
  label: Schema.NonEmptyString,
  contentHash: Schema.NullOr(Schema.NonEmptyString),
  byteLength: Schema.NullOr(Schema.Int),
  verified: Schema.Boolean,
});

export type InspectCapture = (typeof InspectCaptureSchema)['Type'];

export const InspectDuplicateCaptureSchema = Schema.Struct({
  contentHash: Schema.NonEmptyString,
  labels: Schema.Array(Schema.NonEmptyString),
});

export type InspectDuplicateCapture = (typeof InspectDuplicateCaptureSchema)['Type'];

export const InspectCapturesSchema = Schema.Struct({
  entries: Schema.Array(InspectCaptureSchema),
  duplicates: Schema.Array(InspectDuplicateCaptureSchema),
});

export type InspectCaptures = (typeof InspectCapturesSchema)['Type'];

export const RunInspectReportSchema = Schema.Struct({
  schemaVersion: Schema.Literal(RUN_INSPECT_REPORT_SCHEMA_VERSION),
  runId: Schema.NonEmptyString,
  workflowState: Schema.NullOr(WorkflowStateSchema),
  checkpoint: Schema.NullOr(WorkflowStateSchema),
  revision: Schema.Int,
  eventHash: Schema.NullOr(Schema.String),
  historyPath: Schema.NonEmptyString,
  sections: InspectSectionsSchema,
  plan: Schema.NullOr(InspectPlanSchema),
  implementation: Schema.NullOr(InspectImplementationSchema),
  checks: Schema.Array(InspectCheckReportSchema),
  tester: InspectTesterSchema,
  reviewer: Schema.NullOr(InspectReviewerSchema),
  failures: InspectFailuresSchema,
  findings: Schema.Array(FindingRecordSchema),
  corrections: Schema.Array(InspectCorrectionSchema),
  decision: Schema.NullOr(InspectDecisionSchema),
  publication: InspectPublicationSchema,
  journals: Schema.Array(InspectJournalSchema),
  captures: InspectCapturesSchema,
});

export type RunInspectReport = (typeof RunInspectReportSchema)['Type'];

export const INSPECT_DECISION_COMMAND_PREFIX = '/foundry decide';

export interface InspectDecisionCommandInput {
  readonly runId: string;
  readonly decisionId: string;
  readonly optionId: string;
  readonly nonce: string;
}

/**
 * The single canonical authenticated decision command. Foundry prints exactly
 * this command per labeled option, so inspection and the decision PR can never
 * disagree about how an operator applies an option.
 */
export function renderDecisionCommand(input: InspectDecisionCommandInput): string {
  return `${INSPECT_DECISION_COMMAND_PREFIX} ${input.runId} ${input.decisionId} ${input.optionId} ${input.nonce}`;
}

/**
 * Forward-compatible decision/publication records introduced by decision
 * publication. Inspection is a read-only consumer of the canonical history, so
 * it recognizes these records structurally and tolerates their absence: a
 * history recorded before that surface existed simply omits the section.
 */
const ForwardDecisionOpenedSchema = Schema.Struct({
  type: Schema.Literal('decision-opened'),
  payload: Schema.Struct({
    decisionId: Schema.String,
    nonce: Schema.String,
    resultCommit: Schema.optional(Schema.String),
  }),
});

const ForwardPublicationCheckpointSchema = Schema.Struct({
  type: Schema.Literal('publication-checkpoint'),
  payload: Schema.Struct({
    stage: Schema.String,
    draftPrUrl: Schema.optional(Schema.NullOr(Schema.String)),
    decisionId: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
  }),
});

const ForwardDecisionAppliedSchema = Schema.Struct({
  type: Schema.Literal('decision-applied'),
  payload: Schema.Struct({
    decisionId: Schema.String,
    optionId: Schema.String,
    action: Schema.Literals(REVIEWER_DECISION_ACTIONS),
  }),
});

export const InspectForwardEventSchema = Schema.Union([
  ForwardDecisionOpenedSchema,
  ForwardPublicationCheckpointSchema,
  ForwardDecisionAppliedSchema,
]);

export type InspectForwardEvent = (typeof InspectForwardEventSchema)['Type'];

export interface InspectForwardDecisionRecords {
  readonly decisionId: string | null;
  readonly nonce: string | null;
  readonly resultCommit: string | null;
  readonly checkpoints: ReadonlyArray<InspectPublicationCheckpoint>;
  readonly applied: { readonly decisionId: string; readonly optionId: string } | null;
}
