import { createHash } from 'node:crypto';
import { Schema } from 'effect';

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
} from './workflow.js';

import type { ProjectVerificationReport, VerificationExecution } from './project-verification.js';
import type { RuntimeLifecycleRecord } from './project-runtime.js';
import type { RoleHostSessionState } from './role-host.js';
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
  'plan-accepted',
  'role-permission-violation',
  'implementation-accepted',
  'verification-completed',
  'tester-skipped',
  'validation-limitation',
  'runtime-lifecycle',
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

export const RoleSessionSubmissionRequestedPayloadSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: PositiveCount,
  idempotencyKey: Schema.NonEmptyString,
  promptHash: Sha256Hex,
  baselineSequence: Schema.Natural,
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

export const PlanAcceptedEventSchema = Schema.Struct({
  ...RunEventEnvelopeFields,
  type: Schema.Literal('plan-accepted'),
  payload: PlanAcceptedPayloadSchema,
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
  PlanAcceptedEventSchema,
  RolePermissionViolationEventSchema,
  ImplementationAcceptedEventSchema,
  VerificationCompletedEventSchema,
  TesterSkippedEventSchema,
  ValidationLimitationEventSchema,
  RuntimeLifecycleEventSchema,
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
  | { readonly type: 'plan-accepted'; readonly payload: PlanAcceptedPayload }
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
  | { readonly type: 'runtime-lifecycle'; readonly payload: RuntimeLifecyclePayload };

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
  readonly acceptedPlan: PlanAcceptedPayload | null;
  readonly implementation: ImplementationAcceptedPayload | null;
  readonly permissionViolations: ReadonlyArray<RolePermissionViolationPayload>;
  readonly verifications: ReadonlyArray<VerificationCompletedPayload>;
  readonly testerSkips: ReadonlyArray<TesterSkippedPayload>;
  readonly validationLimitations: ReadonlyArray<ValidationLimitationPayload>;
  readonly runtimeLifecycles: ReadonlyArray<RuntimeLifecyclePayload>;
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
          promptHash: event.payload.promptHash,
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
    case 'plan-accepted':
      return { ...envelope, type: 'plan-accepted', payload: event.payload };
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
  const roleSessions = new Map<string, RoleHostSessionState>();
  const permissionViolations: Array<RolePermissionViolationPayload> = [];
  const verifications: Array<VerificationCompletedPayload> = [];
  const testerSkips: Array<TesterSkippedPayload> = [];
  const validationLimitations: Array<ValidationLimitationPayload> = [];
  const runtimeLifecycles: Array<RuntimeLifecyclePayload> = [];
  let acceptedPlan: PlanAcceptedPayload | null = null;
  let implementation: ImplementationAcceptedPayload | null = null;
  let previousHash: string | null = null;

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
          if (existing.role === role && existing.attempt === attempt) {
            return {
              ok: false,
              problem: `${label} starts a second session for role "${role}" attempt ${attempt}`,
            };
          }
        }
        roleSessions.set(sessionId, {
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
        if (session.submission !== null) {
          return { ok: false, problem: `${label} records a second submission intent` };
        }
        if (session.generation !== event.payload.generation) {
          return {
            ok: false,
            problem: `${label} records a submission generation that differs from its session`,
          };
        }
        if (event.payload.baselineSequence < session.initialSequence) {
          return {
            ok: false,
            problem: `${label} records a submission baseline older than the session sequence`,
          };
        }
        roleSessions.set(event.payload.sessionId, {
          ...session,
          submission: {
            idempotencyKey: event.payload.idempotencyKey,
            promptHash: event.payload.promptHash,
            baselineSequence: event.payload.baselineSequence,
          },
        });
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
        if (session.generation !== event.payload.generation) {
          return {
            ok: false,
            problem: `${label} records a submission generation that differs from its session`,
          };
        }
        if (session.submission === null) {
          return { ok: false, problem: `${label} starts a submission before recording its intent` };
        }
        if (session.submission.idempotencyKey !== event.payload.idempotencyKey) {
          return { ok: false, problem: `${label} changes the recorded idempotency key` };
        }
        if (session.submissionStarted !== null) {
          return { ok: false, problem: `${label} records a second submission start` };
        }
        roleSessions.set(event.payload.sessionId, {
          ...session,
          submissionStarted: event.payload.submission,
        });
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
        if (session.generation !== event.payload.generation) {
          return {
            ok: false,
            problem: `${label} records an observation generation that differs from its session`,
          };
        }
        const previousObservation = session.lastObservation;
        if (
          previousObservation !== null &&
          (previousObservation.status === 'settled' || previousObservation.status === 'lost')
        ) {
          return { ok: false, problem: `${label} observes a session after it became terminal` };
        }
        const baseline = session.submission?.baselineSequence ?? session.initialSequence;
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
        } else if (event.payload.narrative !== null || event.payload.control !== null) {
          return {
            ok: false,
            problem: `${label} records an unfinished observation with a settled result`,
          };
        }
        roleSessions.set(event.payload.sessionId, {
          ...session,
          lastObservation: {
            status: event.payload.status,
            sequence: event.payload.sequence,
            eventCount: event.payload.eventCount,
            narrative: event.payload.narrative,
            control: event.payload.control,
          },
        });
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
        if (session.generation !== event.payload.generation) {
          return {
            ok: false,
            problem: `${label} records a stop generation that differs from its session`,
          };
        }
        if (session.stopDisposition !== null) {
          return { ok: false, problem: `${label} records a second stop disposition` };
        }
        roleSessions.set(event.payload.sessionId, {
          ...session,
          stopDisposition: event.payload.disposition,
        });
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
      roleSessions: [...roleSessions.values()],
      acceptedPlan,
      implementation,
      permissionViolations,
      verifications,
      testerSkips,
      validationLimitations,
      runtimeLifecycles,
    },
  };
}
