import { Effect, Schema } from 'effect';
import { join } from 'node:path';

import { Identifier } from '../../domain/run-identity.js';
import {
  CLEANUP_PROGRESS_FILENAME,
  WORKFLOW_ATTEMPT_KINDS,
  WORKFLOW_TRANSITION_ROUTE_KINDS,
  WorkflowStateSchema,
  evaluateWorkflowTransition,
  isActiveWorkflowState,
  isTerminalWorkflowState,
} from '../../domain/workflow.js';
import { RunGit } from '../git-provisioning/index.js';
import { RunStateUnavailable, reconcileRunReports } from '../run-identity/index.js';
import { RunHistoryIntegrityError, appendRunEvent } from '../run-history/index.js';

import type { RunWorkspaceBlocked } from '../git-provisioning/index.js';

import type {
  CleanupOutcome,
  WorkflowAttempt,
  WorkflowAttemptKind,
  WorkflowAttemptRequest,
  WorkflowState,
  WorkflowTransitionEvaluation,
  WorkflowTransitionRequest,
  WorkflowTransitionRouteKind,
} from '../../domain/workflow.js';
import type { RunEventDraft } from '../../domain/run-history.js';
import type {
  RunHistoryError,
  RunHistoryStorage,
  VerifiedRunHistory,
} from '../run-history/index.js';

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

function implementationRefusal(
  runId: string,
  from: WorkflowState | null,
  reason: string,
  missingFact: string | null,
): IllegalWorkflowTransition {
  return new IllegalWorkflowTransition({
    message: `Cannot apply the "implementation-ready" route for run "${runId}": ${reason}`,
    runId,
    route: 'implementation-ready',
    from,
    to: 'verifying',
    reason,
    missingFact,
  });
}

const deriveImplementationRequest = Effect.fn('deriveImplementationRequest')(function* (
  runId: string,
  request: Extract<WorkflowTransitionRequest, { readonly route: 'implementation-ready' }>,
  history: VerifiedRunHistory,
): Effect.fn.Return<
  Extract<WorkflowTransitionRequest, { readonly route: 'implementation-ready' }>,
  IllegalWorkflowTransition | RunWorkspaceBlocked,
  RunGit
> {
  const ready = history.derived.worktreeReady;
  if (ready === null) {
    return yield* implementationRefusal(
      runId,
      history.derived.state,
      'The "implementation-ready" route requires durable worktree readiness for this run.',
      'durable worktree readiness',
    );
  }

  const git = yield* RunGit;
  const observed = yield* git.observeImplementation({
    workspace: ready.workspace,
    taskBranch: ready.taskBranch,
    baseCommit: ready.baseCommit,
    runId,
  });
  if (!observed.workspaceExists) {
    return yield* implementationRefusal(
      runId,
      history.derived.state,
      `The assigned worktree ${ready.workspace} does not exist.`,
      'assigned worktree',
    );
  }
  if (observed.currentBranch !== ready.taskBranch) {
    return yield* implementationRefusal(
      runId,
      history.derived.state,
      `The assigned worktree ${ready.workspace} is on ${observed.currentBranch ?? 'a detached HEAD'} instead of the assigned task branch "${ready.taskBranch}".`,
      'assigned task branch at HEAD',
    );
  }
  if (observed.headCommit === null) {
    return yield* implementationRefusal(
      runId,
      history.derived.state,
      `The assigned worktree ${ready.workspace} has no readable HEAD commit.`,
      'real HEAD commit',
    );
  }
  if (!observed.clean) {
    return yield* implementationRefusal(
      runId,
      history.derived.state,
      `The assigned worktree ${ready.workspace} has uncommitted tracked or untracked changes; only a commit on the assigned branch can be accepted.`,
      'clean assigned worktree',
    );
  }
  if (!observed.baseIsAncestor) {
    return yield* implementationRefusal(
      runId,
      history.derived.state,
      `HEAD ${observed.headCommit} is not descended from the frozen source commit ${ready.baseCommit}.`,
      'descendance from the frozen source commit',
    );
  }
  if (request.candidateCommit !== null && request.candidateCommit !== observed.headCommit) {
    return yield* implementationRefusal(
      runId,
      history.derived.state,
      `The supplied candidate commit does not match the current HEAD ${observed.headCommit}.`,
      'candidate commit at the recorded head',
    );
  }

  const candidateCommit = observed.headCommit === ready.baseCommit ? null : observed.headCommit;
  if (candidateCommit === null && !request.noChangeCandidateValidated) {
    return yield* implementationRefusal(
      runId,
      history.derived.state,
      'The "implementation-ready" route requires a new Git-derived candidate commit or a validated no-change candidate.',
      'Git-derived candidate commit or validated no-change candidate',
    );
  }
  return {
    route: 'implementation-ready',
    branchClean: true,
    candidateCommit,
    noChangeCandidateValidated: request.noChangeCandidateValidated,
  };
});

export const transitionWorkflow = Effect.fn('transitionWorkflow')(function* (
  options: TransitionWorkflowOptions,
): Effect.fn.Return<
  WorkflowTransitionReport,
  IllegalWorkflowTransition | RunStateUnavailable | RunWorkspaceBlocked | RunHistoryError,
  RunHistoryStorage | RunGit
> {
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
        if (options.request.route === 'run-created' && history.derived.worktreeReady === null) {
          return yield* transitionRefusal(runId, 'run-created', history.derived.state, {
            ok: false,
            to: 'planning',
            reason:
              'Run creation to planning requires durable source and worktree provisioning checkpoints; they are not recorded.',
            missingFact: 'durable source and worktree provisioning checkpoints',
          });
        }
        if (options.request.route === 'run-created' && history.derived.guidanceFrozen === null) {
          return yield* transitionRefusal(runId, 'run-created', history.derived.state, {
            ok: false,
            to: 'planning',
            reason:
              'Run creation to planning requires a durable frozen guidance checkpoint; it is not recorded.',
            missingFact: 'durable frozen guidance checkpoint',
          });
        }
        const request =
          options.request.route === 'implementation-ready'
            ? yield* deriveImplementationRequest(runId, options.request, history)
            : options.request;
        const evaluation = evaluateWorkflowTransition(
          { state: history.derived.state, checkpoint: history.derived.checkpoint },
          request,
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

  yield* reconcileRunReports({ runDirectory: options.runDirectory, runId });
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
  IllegalWorkflowAttempt | RunStateUnavailable | RunHistoryError,
  RunHistoryStorage
> {
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

  yield* reconcileRunReports({ runDirectory: options.runDirectory, runId });
  return { runId, workflowState: appended.event.payload.state, attempt: appended.event.payload };
});

export const recordCleanupProgress = Effect.fn('recordCleanupProgress')(function* (
  options: RecordCleanupProgressOptions,
): Effect.fn.Return<
  CleanupProgressReport,
  RunStateUnavailable | RunHistoryError,
  RunHistoryStorage
> {
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

  yield* reconcileRunReports({ runDirectory: options.runDirectory, runId });
  return {
    runId,
    cleanupProgressPath: join(options.runDirectory, CLEANUP_PROGRESS_FILENAME),
    outcome: options.outcome,
  };
});
