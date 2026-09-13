import { Effect } from 'effect';

import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';

import type { EvidenceInvalidatedPayload } from '../../domain/run-history.js';
import type {
  RunHistoryError,
  RunHistoryStorage,
  VerifiedRunHistory,
} from '../run-history/index.js';

/**
 * Evidence facts for the current accepted result head. Reviewer reads
 * `verificationBoundToHead`/`testerObservationBoundToHead`/`runtimeReadyForHead`
 * so an observation of a previous commit can never approve a corrected result.
 */
export interface HeadEvidenceFacts {
  readonly resultCommit: string | null;
  readonly verificationBoundToHead: boolean;
  readonly testerObservationBoundToHead: boolean;
  readonly runtimeReadyForHead: boolean;
  readonly anyTesterObservationBinding: boolean;
  readonly retired: ReadonlyArray<EvidenceInvalidatedPayload>;
}

function resultCommitOf(history: VerifiedRunHistory): string | null {
  const implementation = history.derived.implementation;
  if (implementation === null) {
    return null;
  }
  return implementation.commit ?? implementation.baseCommit;
}

export function headEvidenceFacts(history: VerifiedRunHistory): HeadEvidenceFacts {
  const resultCommit = resultCommitOf(history);
  const bindings = history.derived.evidenceBindings;
  if (resultCommit === null) {
    return {
      resultCommit: null,
      verificationBoundToHead: false,
      testerObservationBoundToHead: false,
      runtimeReadyForHead: false,
      anyTesterObservationBinding: bindings.length > 0,
      retired: history.derived.evidenceInvalidations,
    };
  }
  return {
    resultCommit,
    verificationBoundToHead: history.derived.verifications.some(
      (report) => report.commit === resultCommit,
    ),
    testerObservationBoundToHead: bindings.some((binding) => binding.commit === resultCommit),
    runtimeReadyForHead: history.derived.runtimeLifecycles.some(
      (record) => record.commit === resultCommit && record.outcome === 'ready',
    ),
    anyTesterObservationBinding: bindings.length > 0,
    retired: history.derived.evidenceInvalidations,
  };
}

function latestSettledTesterSessionId(history: VerifiedRunHistory): string | null {
  const sessions = [...history.derived.roleSessions].reverse();
  const settled = sessions.find(
    (session) => session.role === 'tester' && session.lastObservation?.status === 'settled',
  );
  return settled?.sessionId ?? null;
}

export interface BindTesterObservationOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly commit: string;
}

/**
 * Binds the settled Tester observation of the current result head to its
 * commit. Without a settled Tester session there is no observation to bind, so
 * the call records nothing.
 */
export const bindTesterObservation = Effect.fn('bindTesterObservation')(function* (
  options: BindTesterObservationOptions,
): Effect.fn.Return<void, RunHistoryError, RunHistoryStorage> {
  const history = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  const sessionId = latestSettledTesterSessionId(history);
  if (sessionId === null) {
    return;
  }
  if (
    history.derived.evidenceBindings.some(
      (binding) => binding.commit === options.commit && binding.sessionId === sessionId,
    )
  ) {
    return;
  }
  yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'evidence-bound',
        payload: {
          kind: 'tester-observation',
          sessionId,
          commit: options.commit,
        },
      } as const),
  });
});

export interface RetireEvidenceForHeadOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly newHeadCommit: string | null;
  readonly reason: string;
}

interface RetiredRevision {
  readonly retiredKinds: EvidenceInvalidatedPayload['retiredKinds'];
  readonly retiredCommit: string;
  readonly retiredRevision: number;
}

function retiredRevisions(
  history: VerifiedRunHistory,
  newHeadCommit: string,
): ReadonlyArray<RetiredRevision> {
  const alreadyRetired = new Set(
    history.derived.evidenceInvalidations.map((invalidated) => invalidated.retiredRevision),
  );
  const retirements: Array<RetiredRevision> = [];
  for (const [index, event] of history.events.entries()) {
    const retiredRevision = index + 1;
    if (alreadyRetired.has(retiredRevision)) {
      continue;
    }
    if (event.type === 'verification-completed' && event.payload.commit !== newHeadCommit) {
      retirements.push({
        retiredKinds: 'verification',
        retiredCommit: event.payload.commit,
        retiredRevision,
      });
    } else if (event.type === 'evidence-bound' && event.payload.commit !== newHeadCommit) {
      retirements.push({
        retiredKinds: 'tester-observation',
        retiredCommit: event.payload.commit,
        retiredRevision,
      });
    }
  }
  return retirements;
}

/**
 * Retires commit-bound checks and Tester observations that belong to an earlier
 * accepted result head. Called after the new head is durably accepted, so the
 * verifier can require every retired commit to differ from the current head.
 * Idempotent: already-retired revisions are skipped, and a partial retirement
 * is completed by a later call.
 */
export const retireEvidenceForHead = Effect.fn('retireEvidenceForHead')(function* (
  options: RetireEvidenceForHeadOptions,
): Effect.fn.Return<void, RunHistoryError, RunHistoryStorage> {
  if (options.newHeadCommit === null) {
    return;
  }
  const history = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  const retirements = retiredRevisions(history, options.newHeadCommit);
  for (const retirement of retirements) {
    yield* appendRunEvent({
      runDirectory: options.runDirectory,
      runId: options.runId,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'evidence-invalidated',
          payload: {
            retiredKinds: retirement.retiredKinds,
            reason: options.reason,
            retiredCommit: retirement.retiredCommit,
            retiredRevision: retirement.retiredRevision,
          },
        } as const),
    });
  }
});
