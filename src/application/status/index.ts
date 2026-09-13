import { DateTime, Effect, Option } from 'effect';
import { join } from 'node:path';

import { RUN_HISTORY_FILENAME } from '../../domain/run-history.js';
import { readRunWorkflowState } from '../run-identity/index.js';
import { readVerifiedRunHistory } from '../run-history/index.js';

import type {
  CleanupProgressPayload,
  RunEvent,
  RunHistoryDerivedState,
  RunHistoryEventType,
} from '../../domain/run-history.js';
import type { RoleHostSessionState } from '../../domain/role-host.js';
import type { WorkflowAttempt, WorkflowRole, WorkflowState } from '../../domain/workflow.js';
import type { ReadinessFiles } from '../readiness/index.js';
import type { RunProvenance, RunStateUnavailable } from '../run-identity/index.js';
import type {
  RunHistoryConflict,
  RunHistoryIntegrityError,
  RunHistoryStorage,
  RunHistoryStorageError,
  VerifiedRunHistory,
} from '../run-history/index.js';

/**
 * Status is a bounded, read-only projection of one verified history snapshot.
 * Every field is either derived from that snapshot or explicitly unknown; a
 * missing figure is never presented as a measured zero.
 */
export const STATUS_EVENT_DETAIL_LIMIT = 200;

export interface StatusMeasure {
  readonly available: boolean;
  readonly total: number | null;
  readonly detail: string;
}

export interface StatusCounts {
  readonly roleAttempts: number;
  readonly retries: number;
  readonly repairs: number;
  readonly controlRepairs: number;
  readonly corrections: number;
  readonly findings: number;
}

export interface StatusLastEvent {
  readonly revision: number;
  readonly type: RunHistoryEventType;
  readonly occurredAt: string;
  readonly detail: string;
}

export interface StatusActiveRole {
  readonly role: WorkflowRole;
  readonly attempt: number;
}

export interface StatusUsage {
  readonly tokens: StatusMeasure;
  readonly cost: StatusMeasure;
}

export interface RunStatusReport {
  readonly runId: string;
  readonly workflowState: WorkflowState;
  readonly checkpoint: WorkflowState | null;
  readonly activeRole: StatusActiveRole | null;
  readonly startedAt: string | null;
  readonly elapsedMs: number | null;
  readonly lastEvent: StatusLastEvent | null;
  readonly branch: string | null;
  readonly commit: string | null;
  readonly counts: StatusCounts;
  readonly usage: StatusUsage;
  readonly attempts: ReadonlyArray<WorkflowAttempt>;
  readonly cleanupProgress: CleanupProgressPayload | null;
  readonly provenance: RunProvenance | null;
  readonly historyPath: string;
  readonly revision: number;
  readonly eventHash: string | null;
}

export interface ReadRunStatusOptions {
  readonly configArg: string;
  readonly cwd: string;
  readonly runId: string;
}

export interface BuildRunStatusOptions {
  readonly runDirectory: string;
  readonly history: VerifiedRunHistory;
  readonly nowMillis: number;
}

export type RunStatusError =
  | RunStateUnavailable
  | RunHistoryIntegrityError
  | RunHistoryStorageError
  | RunHistoryConflict;

const UNKNOWN_TOKENS: StatusMeasure = {
  available: false,
  total: null,
  detail: 'Token usage is not recorded in the canonical run history.',
};

const UNKNOWN_COST: StatusMeasure = {
  available: false,
  total: null,
  detail: 'Cost estimate is unavailable because token usage is not recorded.',
};

function boundedDetail(text: string): string {
  const collapsed = text.replaceAll(/\s+/gu, ' ').trim();
  return collapsed.length > STATUS_EVENT_DETAIL_LIMIT
    ? collapsed.slice(0, STATUS_EVENT_DETAIL_LIMIT)
    : collapsed;
}

function eventDetail(event: RunEvent): string {
  switch (event.type) {
    case 'run-created':
      return boundedDetail(`run created for task ${event.payload.taskId}`);
    case 'source-frozen':
      return boundedDetail(`source frozen at ${event.payload.sourceCommit}`);
    case 'guidance-frozen':
      return boundedDetail(`guidance frozen from ${event.payload.manifestPath}`);
    case 'worktree-ready':
      return boundedDetail(`worktree ready at ${event.payload.headCommit}`);
    case 'workflow-transition':
      return boundedDetail(`workflow ${event.payload.route} to ${event.payload.to}`);
    case 'workflow-attempt':
      return boundedDetail(
        `${event.payload.kind} for ${event.payload.role}: ${event.payload.reason}`,
      );
    case 'cleanup-progress':
      return boundedDetail(`cleanup ${event.payload.outcome}: ${event.payload.detail}`);
    case 'role-session-created':
      return boundedDetail(
        `${event.payload.role} session attempt ${event.payload.attempt} created`,
      );
    case 'role-session-submission-requested':
      return boundedDetail(`prompt submitted to session ${event.payload.sessionId}`);
    case 'role-session-submission-started':
      return boundedDetail(
        `submission ${event.payload.submission} for session ${event.payload.sessionId}`,
      );
    case 'role-session-observed':
      return boundedDetail(`session ${event.payload.sessionId} observed ${event.payload.status}`);
    case 'role-session-stopped':
      return boundedDetail(`session ${event.payload.sessionId} stopped`);
    case 'role-control-rejected':
      return boundedDetail(
        `control rejected for session ${event.payload.sessionId}: ${event.payload.problem}`,
      );
    case 'role-control-repair-requested':
      return boundedDetail(`control repair requested for session ${event.payload.sessionId}`);
    case 'role-control-repair-started':
      return boundedDetail(`control repair started for session ${event.payload.sessionId}`);
    case 'plan-accepted':
      return boundedDetail(`plan accepted (${event.payload.outcome})`);
    case 'finding-recorded':
      return boundedDetail(
        `finding ${event.payload.id} recorded (${event.payload.severity}, ${event.payload.owner})`,
      );
    case 'role-permission-violation':
      return boundedDetail(`${event.payload.role} permission violation: ${event.payload.kind}`);
    case 'implementation-accepted':
      return event.payload.commit === null
        ? boundedDetail('implementation accepted with no change')
        : boundedDetail(`implementation accepted at ${event.payload.commit}`);
    case 'verification-completed':
      return boundedDetail(`verification ${event.payload.result} for ${event.payload.commit}`);
    case 'tester-skipped':
      return boundedDetail(`tester skipped: ${event.payload.reason}`);
    case 'validation-limitation':
      return boundedDetail(`validation limitation retained for ${event.payload.commit}`);
    case 'runtime-lifecycle':
      return boundedDetail(`runtime ${event.payload.outcome}`);
    case 'decision-opened':
      return boundedDetail(
        `decision ${event.payload.decisionId} opened at ${event.payload.resultCommit}`,
      );
    case 'publication-checkpoint':
      return boundedDetail(`publication ${event.payload.stage}: ${event.payload.detail}`);
    case 'objective-worker':
      return boundedDetail(
        `objective ${event.payload.objectiveId} worker ${event.payload.phase}${
          event.payload.commit === null ? '' : ` at ${event.payload.commit}`
        }`,
      );
  }
}

function activeRoleForState(state: WorkflowState): WorkflowRole | null {
  switch (state) {
    case 'planning':
      return 'architect';
    case 'coding':
    case 'correcting':
      return 'coder';
    case 'testing':
      return 'tester';
    case 'reviewing':
      return 'reviewer';
    default:
      return null;
  }
}

function activeAttemptFor(
  sessions: ReadonlyArray<RoleHostSessionState>,
  role: WorkflowRole,
): number {
  let attempt = 0;
  for (const session of sessions) {
    if (session.role === role && session.attempt > attempt) {
      attempt = session.attempt;
    }
  }
  return attempt === 0 ? 1 : attempt;
}

function countCorrections(events: ReadonlyArray<RunEvent>): number {
  let corrections = 0;
  for (const event of events) {
    if (
      event.type === 'workflow-transition' &&
      (event.payload.route === 'correction-required' || event.payload.route === 'human-corrected')
    ) {
      corrections += 1;
    }
  }
  return corrections;
}

function countsOf(history: VerifiedRunHistory): StatusCounts {
  const derived = history.derived;
  let retries = 0;
  let repairs = 0;
  for (const attempt of derived.attempts) {
    if (attempt.kind === 'retry') {
      retries += 1;
    } else {
      repairs += 1;
    }
  }
  return {
    roleAttempts: derived.roleSessions.length,
    retries,
    repairs,
    controlRepairs: derived.roleControlRepairs.length,
    corrections: countCorrections(history.events),
    findings: derived.findings.length,
  };
}

function provenanceOf(derived: RunHistoryDerivedState): RunProvenance | null {
  const frozen = derived.sourceFrozen;
  const ready = derived.worktreeReady;
  if (frozen === null || ready === null) {
    return null;
  }
  return {
    repositoryRoot: frozen.repository.repositoryRoot,
    gitDirectory: frozen.repository.gitDirectory,
    remoteUrl: frozen.repository.remoteUrl,
    sourceRemote: frozen.sourceRemote,
    sourceBranch: frozen.sourceBranch,
    sourceCommit: frozen.sourceCommit,
    taskBranch: frozen.taskBranch,
    workspace: frozen.workspace,
    headCommit: ready.headCommit,
  };
}

function branchOf(derived: RunHistoryDerivedState): string | null {
  return derived.worktreeReady?.taskBranch ?? derived.sourceFrozen?.taskBranch ?? null;
}

function commitOf(derived: RunHistoryDerivedState): string | null {
  const implementation = derived.implementation;
  if (implementation !== null) {
    return implementation.commit ?? implementation.baseCommit;
  }
  return derived.worktreeReady?.headCommit ?? derived.sourceFrozen?.sourceCommit ?? null;
}

function instantMillis(instant: string): number | null {
  const parsed = DateTime.make(instant);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
}

export function buildRunStatus(options: BuildRunStatusOptions): RunStatusReport {
  const { history, runDirectory, nowMillis } = options;
  const derived = history.derived;
  const state = derived.state ?? 'blocked';
  const events = history.events;
  const first = events[0] ?? null;
  const last = events[events.length - 1] ?? null;
  const role = activeRoleForState(state);
  const startedAt = first?.occurredAt ?? null;
  const startedMillis = startedAt === null ? null : instantMillis(startedAt);
  return {
    runId: history.runId,
    workflowState: state,
    checkpoint: derived.checkpoint,
    activeRole:
      role === null ? null : { role, attempt: activeAttemptFor(derived.roleSessions, role) },
    startedAt,
    elapsedMs: startedMillis === null ? null : Math.max(0, Math.trunc(nowMillis - startedMillis)),
    lastEvent:
      last === null
        ? null
        : {
            revision: last.revision,
            type: last.type,
            occurredAt: last.occurredAt,
            detail: eventDetail(last),
          },
    branch: branchOf(derived),
    commit: commitOf(derived),
    counts: countsOf(history),
    usage: { tokens: UNKNOWN_TOKENS, cost: UNKNOWN_COST },
    attempts: derived.attempts,
    cleanupProgress: derived.cleanupProgress,
    provenance: provenanceOf(derived),
    historyPath: join(runDirectory, RUN_HISTORY_FILENAME),
    revision: history.head.revision,
    eventHash: history.head.eventHash,
  };
}

export const readRunStatus = Effect.fn('readRunStatus')(function* (
  options: ReadRunStatusOptions,
): Effect.fn.Return<RunStatusReport, RunStatusError, ReadinessFiles | RunHistoryStorage> {
  const progress = yield* readRunWorkflowState(options);
  const history = yield* readVerifiedRunHistory({
    runDirectory: progress.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  const now = yield* DateTime.now;
  return buildRunStatus({
    runDirectory: progress.runDirectory,
    history,
    nowMillis: DateTime.toEpochMillis(now),
  });
});
