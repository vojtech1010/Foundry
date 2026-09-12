import { Effect, Schema } from 'effect';
import { join } from 'node:path';

import { Identifier } from '../../domain/run-identity.js';
import {
  CLEANUP_PROGRESS_FILENAME,
  CLEANUP_PROGRESS_SCHEMA_VERSION,
  WORKFLOW_ATTEMPT_KINDS,
  WORKFLOW_STATE_FILENAME,
  WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
  WORKFLOW_TRANSITION_ROUTE_KINDS,
  WorkflowStateSchema,
  evaluateWorkflowTransition,
  isActiveWorkflowState,
  isTerminalWorkflowState,
} from '../../domain/workflow.js';
import { RunIdentityStore, RunStateUnavailable } from '../run-identity/index.js';
import { RunHistoryIntegrityError, appendRunEvent } from '../run-history/index.js';

import type {
  CleanupOutcome,
  CleanupProgressDocument,
  WorkflowAttempt,
  WorkflowAttemptKind,
  WorkflowAttemptRequest,
  WorkflowProgressDocument,
  WorkflowState,
  WorkflowTransitionEvaluation,
  WorkflowTransitionRequest,
  WorkflowTransitionRouteKind,
} from '../../domain/workflow.js';
import type { RunEventDraft } from '../../domain/run-history.js';
import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';
import type { RunIdentityStorageError } from '../run-identity/index.js';

export class IllegalWorkflowTransition extends Schema.TaggedError<IllegalWorkflowTransition>()(
  'IllegalWorkflowTransition',
  {
    message: Schema.String,
    runId: Schema.String,
    route: Schema.Literals(WORKFLOW_TRANSITION_ROUTE_KINDS),
    from: Schema.NullOr(WorkflowStateSchema),
    to: Schema.NullOr(WorkflowStateSchema),
    reason: Schema.String,
    missingFact: Schema.NullOr(Schema.String),
  },
) {}

export class IllegalWorkflowAttempt extends Schema.TaggedError<IllegalWorkflowAttempt>()(
  'IllegalWorkflowAttempt',
  {
    message: Schema.String,
    runId: Schema.String,
    kind: Schema.Literals(WORKFLOW_ATTEMPT_KINDS),
    state: WorkflowStateSchema,
    reason: Schema.String,
    missingFact: Schema.NullOr(Schema.String),
  },
) {}

export interface TransitionWorkflowOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly request: WorkflowTransitionRequest;
}

export interface WorkflowTransitionReport {
  readonly runId: string;
  readonly route: WorkflowTransitionRouteKind;
  readonly previousState: WorkflowState | null;
  readonly workflowState: WorkflowState;
}

export interface RecordWorkflowAttemptOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly attempt: WorkflowAttemptRequest;
}

export interface WorkflowAttemptReport {
  readonly runId: string;
  readonly workflowState: WorkflowState;
  readonly attempt: WorkflowAttempt;
}

export interface RecordCleanupProgressOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly outcome: CleanupOutcome;
  readonly detail: string;
}

export interface CleanupProgressReport {
  readonly runId: string;
  readonly cleanupProgressPath: string;
  readonly outcome: CleanupOutcome;
}

function statePathOf(runDirectory: string): string {
  return join(runDirectory, WORKFLOW_STATE_FILENAME);
}

function encodeDocument(document: WorkflowProgressDocument | CleanupProgressDocument): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
}

function invalidRunId(runId: string): RunStateUnavailable {
  return new RunStateUnavailable({
    message: `Run ID "${runId}" is not a valid run identifier.`,
    runId,
  });
}

function transitionRefusal(
  runId: string,
  route: WorkflowTransitionRouteKind,
  from: WorkflowState | null,
  evaluation: Extract<WorkflowTransitionEvaluation, { readonly ok: false }>,
): IllegalWorkflowTransition {
  return new IllegalWorkflowTransition({
    message: `Cannot apply the "${route}" route for run "${runId}": ${evaluation.reason}`,
    runId,
    route,
    from,
    to: evaluation.to,
    reason: evaluation.reason,
    missingFact: evaluation.missingFact,
  });
}

function attemptRefusal(
  runId: string,
  kind: WorkflowAttemptKind,
  state: WorkflowState,
  missingFact: string | null,
  reason: string,
): IllegalWorkflowAttempt {
  return new IllegalWorkflowAttempt({
    message: `Cannot record a ${kind} for run "${runId}": ${reason}`,
    runId,
    kind,
    state,
    reason,
    missingFact,
  });
}

export const transitionWorkflow = Effect.fn('transitionWorkflow')(function* (
  options: TransitionWorkflowOptions,
): Effect.fn.Return<
  WorkflowTransitionReport,
  IllegalWorkflowTransition | RunStateUnavailable | RunIdentityStorageError | RunHistoryError,
  RunIdentityStore | RunHistoryStorage
> {
  const store = yield* RunIdentityStore;
  const runId = options.runId;
  if (!Schema.is(Identifier)(runId)) {
    return yield* invalidRunId(runId);
  }

  const appended = yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId,
    createIfMissing: options.request.route === 'run-created',
    build: (history) =>
      Effect.gen(function* () {
        const evaluation = evaluateWorkflowTransition(
          { state: history.derived.state, checkpoint: history.derived.checkpoint },
          options.request,
        );
        if (!evaluation.ok) {
          return yield* transitionRefusal(
            runId,
            options.request.route,
            history.derived.state,
            evaluation,
          );
        }
        return {
          type: 'workflow-transition',
          payload: {
            route: options.request.route,
            from: history.derived.state,
            to: evaluation.to,
            checkpoint: evaluation.checkpoint,
          },
        } satisfies RunEventDraft;
      }),
  });

  const document: WorkflowProgressDocument = {
    schemaVersion: WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
    runId,
    state: appended.event.payload.to,
    checkpoint: appended.event.payload.checkpoint,
    attempts: appended.previous.derived.attempts,
  };
  yield* store.writeFileBytes(statePathOf(options.runDirectory), encodeDocument(document));
  return {
    runId,
    route: options.request.route,
    previousState: appended.event.payload.from,
    workflowState: appended.event.payload.to,
  };
});

export const recordWorkflowAttempt = Effect.fn('recordWorkflowAttempt')(function* (
  options: RecordWorkflowAttemptOptions,
): Effect.fn.Return<
  WorkflowAttemptReport,
  IllegalWorkflowAttempt | RunStateUnavailable | RunIdentityStorageError | RunHistoryError,
  RunIdentityStore | RunHistoryStorage
> {
  const store = yield* RunIdentityStore;
  const runId = options.runId;
  if (!Schema.is(Identifier)(runId)) {
    return yield* invalidRunId(runId);
  }
  const attempt = options.attempt;

  const appended = yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId,
    createIfMissing: false,
    build: (history) =>
      Effect.gen(function* () {
        const progress = history.derived;
        const state = progress.state;
        if (state === null) {
          return yield* new RunHistoryIntegrityError({
            message: `Run "${runId}" has no active workflow state in its verified history; an attempt cannot be recorded.`,
            runId,
            problem: 'verified history records no workflow state for this attempt',
          });
        }
        if (isTerminalWorkflowState(state)) {
          return yield* attemptRefusal(
            runId,
            attempt.kind,
            state,
            null,
            `Workflow state "${state}" is terminal; no further attempt is allowed.`,
          );
        }
        if (!isActiveWorkflowState(state)) {
          return yield* attemptRefusal(
            runId,
            attempt.kind,
            state,
            'active stage state',
            'Retries and envelope repairs are recorded only while a stage is active.',
          );
        }
        if (attempt.reason.trim().length === 0) {
          return yield* attemptRefusal(
            runId,
            attempt.kind,
            state,
            'recorded attempt reason',
            'An attempt requires a recorded reason.',
          );
        }
        const remaining =
          attempt.kind === 'retry' ? attempt.retriesRemaining : attempt.repairsRemaining;
        if (!Number.isInteger(remaining) || remaining < 1) {
          return yield* attemptRefusal(
            runId,
            attempt.kind,
            state,
            'available attempt budget',
            `No ${attempt.kind} budget remains; the workflow state and recorded attempts are unchanged.`,
          );
        }
        const recorded: WorkflowAttempt = {
          sequence: progress.attempts.length + 1,
          kind: attempt.kind,
          role: attempt.role,
          state,
          reason: attempt.reason,
        };
        return { type: 'workflow-attempt', payload: recorded } satisfies RunEventDraft;
      }),
  });

  const recorded = appended.event.payload;
  const document: WorkflowProgressDocument = {
    schemaVersion: WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
    runId,
    state: recorded.state,
    checkpoint: appended.previous.derived.checkpoint,
    attempts: [...appended.previous.derived.attempts, recorded],
  };
  yield* store.writeFileBytes(statePathOf(options.runDirectory), encodeDocument(document));
  return { runId, workflowState: recorded.state, attempt: recorded };
});

export const recordCleanupProgress = Effect.fn('recordCleanupProgress')(function* (
  options: RecordCleanupProgressOptions,
): Effect.fn.Return<
  CleanupProgressReport,
  RunStateUnavailable | RunIdentityStorageError | RunHistoryError,
  RunIdentityStore | RunHistoryStorage
> {
  const store = yield* RunIdentityStore;
  const runId = options.runId;
  if (!Schema.is(Identifier)(runId)) {
    return yield* invalidRunId(runId);
  }

  yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId,
    createIfMissing: false,
    build: () =>
      Effect.succeed<RunEventDraft>({
        type: 'cleanup-progress',
        payload: { outcome: options.outcome, detail: options.detail },
      }),
  });

  const cleanupProgressPath = join(options.runDirectory, CLEANUP_PROGRESS_FILENAME);
  const document: CleanupProgressDocument = {
    schemaVersion: CLEANUP_PROGRESS_SCHEMA_VERSION,
    runId,
    outcome: options.outcome,
    detail: options.detail,
  };
  yield* store.writeFileBytes(cleanupProgressPath, encodeDocument(document));
  return { runId, cleanupProgressPath, outcome: options.outcome };
});
