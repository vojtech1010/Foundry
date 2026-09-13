import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bindTesterObservation,
  headEvidenceFacts,
  retireEvidenceForHead,
} from '../src/application/evidence-invalidation/index.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { handleReviewerTurn } from '../src/application/reviewer-outcomes/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { handleTesterTurn } from '../src/application/tester-validation/index.js';
import { transitionWorkflow } from '../src/application/workflow-transitions/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import {
  FROZEN_COMMIT,
  IMPLEMENTED_COMMIT,
  RUN_ID,
  TASK_BRANCH,
  passingVerificationReport,
  seedVerifyingRun,
} from './fixtures/checks-runtime-run.js';

import type { Schema } from 'effect';

import type { RunEventDraft } from '../src/domain/run-history.js';
import type { WorkflowTransitionRequest } from '../src/domain/workflow.js';

const NEW_COMMIT = '1234567890abcdef1234567890abcdef12345678';

function stubGit(headCommit: string): Layer.Layer<RunGit> {
  const unused = (name: string) =>
    Effect.die(new Error(`evidence invalidation must not call RunGit.${name}`));
  return Layer.succeed(
    RunGit,
    RunGit.of({
      inspectRepository: () => unused('inspectRepository'),
      fetchSource: () => unused('fetchSource'),
      commitExists: () => unused('commitExists'),
      readBranch: () => unused('readBranch'),
      createBranch: () => unused('createBranch'),
      readWorktree: () => unused('readWorktree'),
      createWorktree: () => unused('createWorktree'),
      observeImplementation: () =>
        Effect.succeed({
          workspaceExists: true,
          currentBranch: TASK_BRANCH,
          headCommit,
          clean: true,
          baseIsAncestor: true,
          changedFiles: ['src/implementation.ts'],
        }),
    }),
  );
}

const Live = Layer.mergeAll(RunHistoryLive, RunIdentityLive, stubGit(NEW_COMMIT));

function setupFixture(label: string) {
  const base = mkdtempSync(join(tmpdir(), `foundry-invalidation-${label}-`));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function emit(runDirectory: string, draft: RunEventDraft) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
    build: () => Effect.succeed(draft),
  }).pipe(Effect.provide(RunHistoryLive));
}

function history(runDirectory: string) {
  return readVerifiedRunHistory({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

function transition(runDirectory: string, request: WorkflowTransitionRequest) {
  return transitionWorkflow({ runDirectory, runId: RUN_ID, request }).pipe(Effect.provide(Live));
}

function seedTesterSession(runDirectory: string, attempt: number, sessionId: string) {
  return Effect.gen(function* () {
    yield* emit(runDirectory, {
      type: 'role-session-created',
      payload: {
        role: 'tester',
        attempt,
        generation: 1,
        sessionId,
        ownershipToken: `${sessionId}-owner`,
        sequence: 0,
        runtimeIdentity: {
          adapterVersion: 'test',
          provider: 'test',
          model: 'test',
          toolProfile: 'test',
        },
        workingDirectory: null,
      },
    });
    yield* emit(runDirectory, {
      type: 'role-session-observed',
      payload: {
        sessionId,
        generation: 1,
        status: 'settled',
        sequence: 1,
        eventCount: 1,
        narrative: 'observed the application',
        control: { schemaVersion: 1, outcome: 'observed' },
      },
    });
  });
}

function emitRuntimeReady(runDirectory: string, commit: string) {
  return emit(runDirectory, {
    type: 'runtime-lifecycle',
    payload: {
      repository: '/target',
      commit,
      baseUrl: 'http://127.0.0.1:3000',
      runtimeKind: 'application',
      startedAt: '2026-09-13T00:00:00.000Z',
      readyAt: '2026-09-13T00:00:01.000Z',
      stoppedAt: null,
      outcome: 'ready',
      cleanup: 'not_owned',
      dataPreserved: true,
      stages: [],
    },
  });
}

function handleTester(runDirectory: string, control: Schema.Json) {
  return handleTesterTurn({
    runDirectory,
    runId: RUN_ID,
    control,
    commit: IMPLEMENTED_COMMIT,
    testerRetriesRemaining: 1,
    retryReason: 'the Tester requested another observation',
  }).pipe(Effect.provide(Live));
}

function handleReviewer(
  runDirectory: string,
  control: Schema.Json,
  runtimeEvidencePresent: boolean,
) {
  return handleReviewerTurn({
    runDirectory,
    runId: RUN_ID,
    control,
    assessment: {
      reviewableCommit: NEW_COMMIT,
      evidenceCommitMatches: true,
      checksPassed: true,
      testerRequired: true,
      runtimeEvidencePresent,
      noChangeCandidate: false,
      correctionRoundsRemaining: 1,
      testerRetriesRemaining: 1,
      publicationEligible: false,
    },
    narrative: '# Reviewer findings\n',
    correctionReason: 'correction requested',
    blockedReason: 'reviewer reported a problem',
  }).pipe(Effect.provide(Live));
}

/**
 * Reaches an accepted head of `NEW_COMMIT` after a fully bound verification and
 * Tester observation of `IMPLEMENTED_COMMIT`.
 */
function seedAdvancedHead(runDirectory: string) {
  return Effect.gen(function* () {
    yield* seedVerifyingRun({ runDirectory, runtimeValidationRequired: true });
    yield* emit(runDirectory, {
      type: 'verification-completed',
      payload: passingVerificationReport(),
    });
    yield* emitRuntimeReady(runDirectory, IMPLEMENTED_COMMIT);
    yield* transition(runDirectory, { route: 'checks-passed-testing', checksPassed: true });
    yield* seedTesterSession(runDirectory, 1, 'tester-1');
    const observed = yield* handleTester(runDirectory, { schemaVersion: 1, outcome: 'observed' });
    if (observed.kind !== 'observed') {
      throw new Error(`Expected the Tester observation to settle, saw ${observed.kind}.`);
    }
    yield* transition(runDirectory, {
      route: 'correction-required',
      findingsBacked: true,
      correctionRoundsRemaining: 1,
    });
    yield* transition(runDirectory, {
      route: 'implementation-ready',
      branchClean: true,
      candidateCommit: NEW_COMMIT,
      noChangeCandidateValidated: false,
    });
  });
}

describe('evidence invalidation on accepted head advance', () => {
  it.effect('retires earlier commit-bound checks and observations on a correction', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('correction');
      try {
        yield* seedAdvancedHead(fixture.runDirectory);
        const after = yield* history(fixture.runDirectory);

        expect(after.derived.state).toBe('verifying');
        expect(after.derived.implementation?.commit).toBe(NEW_COMMIT);
        expect(after.derived.evidenceInvalidations).toHaveLength(2);
        expect(
          [...after.derived.evidenceInvalidations]
            .map((invalidated) => invalidated.retiredKinds)
            .sort(),
        ).toEqual(['tester-observation', 'verification']);
        for (const invalidated of after.derived.evidenceInvalidations) {
          expect(invalidated.reason).toBe('accepted-head-advanced');
          expect(invalidated.retiredCommit).toBe(IMPLEMENTED_COMMIT);
          expect(invalidated.retiredRevision).toBeGreaterThan(0);
        }

        // Retired attempts stay visible in the canonical history.
        expect(
          after.derived.verifications.some((report) => report.commit === IMPLEMENTED_COMMIT),
        ).toBe(true);
        expect(
          after.derived.evidenceBindings.some((binding) => binding.commit === IMPLEMENTED_COMMIT),
        ).toBe(true);

        const facts = headEvidenceFacts(after);
        expect(facts.resultCommit).toBe(NEW_COMMIT);
        expect(facts.anyTesterObservationBinding).toBe(true);
        expect(facts.testerObservationBoundToHead).toBe(false);
        expect(facts.runtimeReadyForHead).toBe(false);
        expect(facts.retired).toHaveLength(2);
      } finally {
        fixture.cleanup();
      }
    }).pipe(Effect.provide(Live)),
  );

  it.effect('refuses approval that still relies on retired evidence', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('mixed');
      try {
        yield* seedAdvancedHead(fixture.runDirectory);
        yield* emitRuntimeReady(fixture.runDirectory, NEW_COMMIT);
        yield* emit(fixture.runDirectory, {
          type: 'verification-completed',
          payload: { ...passingVerificationReport(), attempt: 2, commit: NEW_COMMIT },
        });
        yield* transition(fixture.runDirectory, {
          route: 'checks-passed-reviewing',
          checksPassed: true,
          correctionBudgetExhausted: true,
          reviewableCommit: NEW_COMMIT,
        });

        const disposition = yield* handleReviewer(
          fixture.runDirectory,
          { schemaVersion: 1, outcome: 'approved' },
          true,
        );
        expect(disposition.kind).toBe('blocked');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('blocked');
      } finally {
        fixture.cleanup();
      }
    }).pipe(Effect.provide(Live)),
  );

  it.effect('approves once the current head has its own bound observation', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('rebound');
      try {
        yield* seedAdvancedHead(fixture.runDirectory);
        yield* emitRuntimeReady(fixture.runDirectory, NEW_COMMIT);
        yield* emit(fixture.runDirectory, {
          type: 'verification-completed',
          payload: { ...passingVerificationReport(), attempt: 2, commit: NEW_COMMIT },
        });
        yield* transition(fixture.runDirectory, {
          route: 'checks-passed-reviewing',
          checksPassed: true,
          correctionBudgetExhausted: true,
          reviewableCommit: NEW_COMMIT,
        });
        yield* seedTesterSession(fixture.runDirectory, 2, 'tester-2');

        const beforeBind = yield* history(fixture.runDirectory);
        const factsBefore = headEvidenceFacts(beforeBind);
        expect(factsBefore.anyTesterObservationBinding).toBe(true);
        expect(factsBefore.testerObservationBoundToHead).toBe(false);

        yield* bindTesterObservation({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          commit: NEW_COMMIT,
        }).pipe(Effect.provide(RunHistoryLive));

        const afterBind = yield* history(fixture.runDirectory);
        expect(headEvidenceFacts(afterBind).testerObservationBoundToHead).toBe(true);

        const disposition = yield* handleReviewer(
          fixture.runDirectory,
          { schemaVersion: 1, outcome: 'approved' },
          true,
        );
        expect(disposition).toEqual({ kind: 'approved' });
        const completed = yield* history(fixture.runDirectory);
        expect(completed.derived.state).toBe('completed');
        // The retired attempt remains visible next to the new evidence.
        expect(
          completed.derived.evidenceInvalidations.some(
            (invalidated) => invalidated.retiredCommit === IMPLEMENTED_COMMIT,
          ),
        ).toBe(true);
        expect(
          completed.derived.evidenceBindings.some((binding) => binding.commit === NEW_COMMIT),
        ).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }).pipe(Effect.provide(Live)),
  );

  it.effect('retires evidence for any accepted head advance, not only corrections', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('plain');
      try {
        yield* seedVerifyingRun({
          runDirectory: fixture.runDirectory,
          runtimeValidationRequired: false,
        });
        yield* emit(fixture.runDirectory, {
          type: 'verification-completed',
          payload: passingVerificationReport(),
        });
        const before = yield* history(fixture.runDirectory);
        const verificationRevision =
          before.events.findIndex((event) => event.type === 'verification-completed') + 1;

        // A plain re-implementation records a new head without a correction label.
        yield* emit(fixture.runDirectory, {
          type: 'implementation-accepted',
          payload: {
            taskBranch: TASK_BRANCH,
            baseCommit: FROZEN_COMMIT,
            commit: NEW_COMMIT,
            changedFiles: ['src/implementation.ts'],
            noChangeCandidate: false,
          },
        });
        const retire = retireEvidenceForHead({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          newHeadCommit: NEW_COMMIT,
          reason: 'accepted-head-advanced',
        }).pipe(Effect.provide(RunHistoryLive));
        yield* retire;
        // Idempotent: a repeated call must not retire the same revision twice.
        yield* retire;

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.evidenceInvalidations).toEqual([
          {
            retiredKinds: 'verification',
            reason: 'accepted-head-advanced',
            retiredCommit: IMPLEMENTED_COMMIT,
            retiredRevision: verificationRevision,
          },
        ]);
        const retired = after.events[verificationRevision - 1];
        expect(retired?.type).toBe('verification-completed');
      } finally {
        fixture.cleanup();
      }
    }).pipe(Effect.provide(Live)),
  );
});
