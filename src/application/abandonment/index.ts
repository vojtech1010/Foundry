import { Effect } from 'effect';

import { describeRunCleanupReport } from '../../domain/run-cleanup.js';
import { disposeRunResources } from '../run-cleanup/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';
import { workerWorktreesFor } from '../run-workflow/index.js';
import {
  IllegalWorkflowTransition,
  recordCleanupProgress,
  transitionWorkflow,
} from '../workflow-transitions/index.js';

import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type { CleanupProgressPayload } from '../../domain/run-history.js';
import type { RunGit, RunWorkspaceBlocked } from '../git-provisioning/index.js';
import type {
  OwnedProjectProcess,
  ProjectCommandProcess,
  ProjectEvidenceStore,
} from '../project-commands/index.js';
import type { ReadinessGit } from '../readiness/index.js';
import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';
import type { RoleHostLauncher } from '../role-conversations/index.js';
import type { RunIdentityStore, RunStateUnavailable } from '../run-identity/index.js';

export interface AbandonRunOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly configuration: ProjectConfiguration;
  readonly reason: string;
}

/**
 * The outcome of an explicit abandonment. The terminal `abandoned` state and the
 * best-effort resource cleanup are separate facts: `cleanup` is null only when
 * no cleanup outcome is recorded, and a pending or failed cleanup never changes
 * the terminal state.
 */
export interface AbandonReport {
  readonly runId: string;
  readonly workflowState: 'abandoned';
  readonly reason: string;
  readonly cleanup: CleanupProgressPayload | null;
}

export type AbandonmentError =
  | IllegalWorkflowTransition
  | RunStateUnavailable
  | RunWorkspaceBlocked
  | RunHistoryError;

function reportOf(
  runId: string,
  reason: string,
  cleanup: CleanupProgressPayload | null,
): AbandonReport {
  return { runId, workflowState: 'abandoned', reason, cleanup };
}

function abandonmentNote(reason: string) {
  return { type: 'abandonment-note', payload: { reason } } as const;
}

/**
 * Explicitly ends a nonterminal run. The terminal `abandoned` transition is
 * durably recorded first, so disposal that is still pending or uncertain leaves
 * the run abandoned; the disposition is best-effort and reported separately.
 * Repeating the same reason is idempotent and a different reason appends an
 * audit note without rerunning disposal. Abandonment never approves, commits,
 * publishes, or erases history, and it deliberately does not call `advanceRun`
 * (which could resume a blocked run instead of ending it).
 */
export const abandonRun = Effect.fn('abandonRun')(function* (
  options: AbandonRunOptions,
): Effect.fn.Return<
  AbandonReport,
  AbandonmentError,
  | RunHistoryStorage
  | RunIdentityStore
  | RoleHostLauncher
  | RunGit
  | ReadinessGit
  | ProjectCommandProcess
  | ProjectEvidenceStore
  | OwnedProjectProcess
> {
  const { runDirectory, runId, configuration, reason } = options;
  const before = yield* readVerifiedRunHistory({ runDirectory, runId, createIfMissing: false });
  if (reason.trim().length === 0) {
    return yield* new IllegalWorkflowTransition({
      message: `Cannot abandon run "${runId}": an abandonment reason is required.`,
      runId,
      route: 'abandon-run',
      from: before.derived.state,
      to: 'abandoned',
      reason: 'Abandoning a run requires a recorded reason.',
      missingFact: 'recorded abandonment reason',
    });
  }
  if (before.derived.state === 'abandoned') {
    const notes = before.derived.abandonmentNotes ?? [];
    if (notes.some((note) => note.reason === reason)) {
      return reportOf(runId, reason, before.derived.cleanupProgress);
    }
    const appended = yield* appendRunEvent({
      runDirectory,
      runId,
      createIfMissing: false,
      build: () => Effect.succeed(abandonmentNote(reason)),
    });
    return reportOf(runId, reason, appended.previous.derived.cleanupProgress);
  }

  yield* transitionWorkflow({
    runDirectory,
    runId,
    request: { route: 'abandon-run', explicitRequest: true, reason },
  });

  const transitioned = yield* readVerifiedRunHistory({
    runDirectory,
    runId,
    createIfMissing: false,
  });
  const disposal = yield* disposeRunResources({
    runDirectory,
    runId,
    configuration,
    runtime: null,
    workerWorktrees: workerWorktreesFor(transitioned, runId),
  });
  let cleanup = transitioned.derived.cleanupProgress;
  if (disposal !== null) {
    const detail = describeRunCleanupReport(disposal.resources);
    yield* recordCleanupProgress({ runDirectory, runId, outcome: disposal.outcome, detail });
    cleanup = { outcome: disposal.outcome, detail };
  }

  yield* appendRunEvent({
    runDirectory,
    runId,
    createIfMissing: false,
    build: () => Effect.succeed(abandonmentNote(reason)),
  });
  return reportOf(runId, reason, cleanup);
});
