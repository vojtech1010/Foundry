import { createHash } from 'node:crypto';
import { Schema } from 'effect';

import { Identifier, Sha256Hex } from './run-identity.js';
import {
  CLEANUP_OUTCOMES,
  INITIAL_WORKFLOW_STATE,
  WORKFLOW_ATTEMPT_KINDS,
  WORKFLOW_ROLES,
  WORKFLOW_TRANSITION_ROUTE_KINDS,
  WORKFLOW_TRANSITION_ROUTES,
  WorkflowStateSchema,
  allowsWorkflowRouteFrom,
  isActiveWorkflowState,
} from './workflow.js';

import type { WorkflowAttempt, WorkflowState } from './workflow.js';

export const RUN_HISTORY_SCHEMA_VERSION = 1 as const;

export const RUN_HISTORY_WITNESS_SCHEMA_VERSION = 1 as const;

export const RUN_HISTORY_FILENAME = 'events.jsonl' as const;

export const RUN_HISTORY_WITNESS_FILENAME = 'events.witness.json' as const;

export const RUN_HISTORY_LOCK_FILENAME = 'events.jsonl.lock' as const;

export const RUN_HISTORY_EVENT_TYPES = [
  'run-created',
  'workflow-transition',
  'workflow-attempt',
  'cleanup-progress',
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

export const RunEventSchema = Schema.Union([
  RunCreatedEventSchema,
  WorkflowTransitionEventSchema,
  WorkflowAttemptEventSchema,
  CleanupProgressEventSchema,
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
  | { readonly type: 'workflow-transition'; readonly payload: WorkflowTransitionPayload }
  | { readonly type: 'workflow-attempt'; readonly payload: WorkflowAttemptPayload }
  | { readonly type: 'cleanup-progress'; readonly payload: CleanupProgressPayload };

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
    case 'workflow-transition':
      return { ...envelope, type: 'workflow-transition', payload: event.payload };
    case 'workflow-attempt':
      return { ...envelope, type: 'workflow-attempt', payload: event.payload };
    case 'cleanup-progress':
      return { ...envelope, type: 'cleanup-progress', payload: event.payload };
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
  const attempts: Array<WorkflowAttempt> = [];
  let previousHash: string | null = null;

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
      if (event.type !== 'workflow-transition' || event.payload.route !== 'run-created') {
        return { ok: false, problem: 'history does not begin with run creation' };
      }
    }
    switch (event.type) {
      case 'run-created': {
        if (index !== 0) {
          return { ok: false, problem: `run creation appears again at ${label}` };
        }
        state = INITIAL_WORKFLOW_STATE;
        checkpoint = null;
        break;
      }
      case 'workflow-transition': {
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
        break;
      }
    }
    previousHash = event.eventHash;
  }

  return {
    ok: true,
    head: { revision: events.length, eventHash: previousHash },
    derived: { state, checkpoint, attempts },
  };
}
