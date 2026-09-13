import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';

import type { Schema } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunGit } from '../src/application/git-provisioning/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { handleReviewerTurn } from '../src/application/reviewer-outcomes/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import {
  IMPLEMENTED_COMMIT,
  RUN_ID,
  passingVerificationReport,
  seedVerifyingRun,
} from './fixtures/checks-runtime-run.js';

import type { ReviewerEvidenceAssessment } from '../src/application/reviewer-outcomes/index.js';

function stubGit(): Layer.Layer<RunGit> {
  const unused = (name: string) =>
    Effect.die(new Error(`reviewer outcomes must not call RunGit.${name}`));
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
      observeImplementation: () => unused('observeImplementation'),
    }),
  );
}

const Live = Layer.mergeAll(RunHistoryLive, stubGit());

function setupFixture(label: string) {
  const base = mkdtempSync(join(tmpdir(), `foundry-reviewer-${label}-`));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function seedReviewing(
  runDirectory: string,
  options: {
    readonly runtimeValidationRequired: boolean;
    readonly verificationResult?: 'passed' | 'failed';
    readonly runtimeReady?: boolean;
    readonly observedTester?: boolean;
  },
) {
  return Effect.gen(function* () {
    yield* seedVerifyingRun({
      runDirectory,
      runtimeValidationRequired: options.runtimeValidationRequired,
    });
    const report = {
      ...passingVerificationReport(),
      result: options.verificationResult ?? 'passed',
    };
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () => Effect.succeed({ type: 'verification-completed', payload: report } as const),
    });
    if (options.runtimeReady === true) {
      yield* seedRuntimeReady(runDirectory);
    }
    if (options.observedTester === true) {
      yield* seedObservedTester(runDirectory);
    }
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'workflow-transition',
          payload: {
            route: 'checks-passed-reviewing',
            from: 'verifying',
            to: 'reviewing',
            checkpoint: null,
          },
        } as const),
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function seedRuntimeReady(runDirectory: string) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'runtime-lifecycle',
        payload: {
          repository: '/target',
          commit: IMPLEMENTED_COMMIT,
          baseUrl: 'http://127.0.0.1:3000',
          runtimeKind: 'application' as const,
          startedAt: '2026-09-13T00:00:00.000Z',
          readyAt: '2026-09-13T00:00:01.000Z',
          stoppedAt: null,
          outcome: 'ready' as const,
          cleanup: 'not_owned' as const,
          dataPreserved: true,
          stages: [],
        },
      } as const),
  }).pipe(Effect.provide(RunHistoryLive));
}

function seedObservedTester(runDirectory: string) {
  return Effect.gen(function* () {
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'role-session-created',
          payload: {
            role: 'tester' as const,
            attempt: 1,
            generation: 1,
            sessionId: 'tester-session',
            ownershipToken: 'tester-owner',
            sequence: 0,
            runtimeIdentity: {
              adapterVersion: 'test',
              provider: 'test',
              model: 'test',
              toolProfile: 'test',
            },
            workingDirectory: null,
          },
        } as const),
    });
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'role-session-observed',
          payload: {
            sessionId: 'tester-session',
            generation: 1,
            status: 'settled' as const,
            sequence: 1,
            eventCount: 1,
            narrative: 'observed the application',
            control: { schemaVersion: 1, outcome: 'observed' },
          },
        } as const),
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function assessment(
  overrides: Partial<ReviewerEvidenceAssessment> = {},
): ReviewerEvidenceAssessment {
  return {
    reviewableCommit: IMPLEMENTED_COMMIT,
    evidenceCommitMatches: true,
    checksPassed: true,
    testerRequired: false,
    runtimeEvidencePresent: true,
    noChangeCandidate: false,
    correctionRoundsRemaining: 1,
    testerRetriesRemaining: 1,
    publicationEligible: false,
    ...overrides,
  };
}

function handle(
  runDirectory: string,
  control: Schema.Json,
  overrides: Partial<ReviewerEvidenceAssessment> = {},
) {
  return handleReviewerTurn({
    runDirectory,
    runId: RUN_ID,
    control,
    assessment: assessment(overrides),
    correctionReason: 'correction requested',
    blockedReason: 'reviewer reported a problem',
  }).pipe(Effect.provide(Live));
}

function history(runDirectory: string) {
  return readVerifiedRunHistory({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

describe('Reviewer closed outcomes', () => {
  it.effect('ordinary approval completes locally', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('approved');
      try {
        yield* seedReviewing(fixture.runDirectory, { runtimeValidationRequired: false });
        const disposition = yield* handle(fixture.runDirectory, {
          schemaVersion: 1,
          outcome: 'approved',
        });
        expect(disposition).toEqual({ kind: 'approved' });
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('completed');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('cannot approve failed deterministic checks', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('failed-checks');
      try {
        yield* seedReviewing(fixture.runDirectory, {
          runtimeValidationRequired: false,
          verificationResult: 'failed',
        });
        const disposition = yield* handle(
          fixture.runDirectory,
          { schemaVersion: 1, outcome: 'approved' },
          { checksPassed: false },
        );
        expect(disposition.kind).toBe('blocked');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('blocked');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('cannot approve missing required live evidence', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('missing-runtime');
      try {
        yield* seedReviewing(fixture.runDirectory, {
          runtimeValidationRequired: true,
          runtimeReady: true,
        });
        const disposition = yield* handle(
          fixture.runDirectory,
          { schemaVersion: 1, outcome: 'approved' },
          { testerRequired: true, runtimeEvidencePresent: false },
        );
        expect(disposition.kind).toBe('blocked');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('blocked');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('approves when required live evidence is present', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('with-runtime');
      try {
        yield* seedReviewing(fixture.runDirectory, {
          runtimeValidationRequired: true,
          runtimeReady: true,
          observedTester: true,
        });
        const disposition = yield* handle(
          fixture.runDirectory,
          { schemaVersion: 1, outcome: 'approved' },
          { testerRequired: true, runtimeEvidencePresent: true },
        );
        expect(disposition).toEqual({ kind: 'approved' });
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('completed');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('changes_requested is bounded by the remaining correction round', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('changes');
      try {
        yield* seedReviewing(fixture.runDirectory, { runtimeValidationRequired: false });
        const disposition = yield* handle(fixture.runDirectory, {
          schemaVersion: 1,
          outcome: 'changes_requested',
        });
        expect(disposition).toEqual({ kind: 'changes-requested' });
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('correcting');

        const noBudget = yield* handle(
          fixture.runDirectory,
          { schemaVersion: 1, outcome: 'changes_requested' },
          { correctionRoundsRemaining: 0 },
        );
        expect(noBudget.kind).toBe('control-invalid');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('retest_requested needs a remaining same-commit Tester retry', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('retest');
      try {
        yield* seedReviewing(fixture.runDirectory, { runtimeValidationRequired: true });
        const disposition = yield* handle(
          fixture.runDirectory,
          { schemaVersion: 1, outcome: 'retest_requested' },
          { testerRequired: true, testerRetriesRemaining: 1 },
        );
        expect(disposition).toEqual({ kind: 'retest-requested' });
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('testing');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('retest_requested without a retry is refused', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('retest-budget');
      try {
        yield* seedReviewing(fixture.runDirectory, { runtimeValidationRequired: true });
        const disposition = yield* handle(
          fixture.runDirectory,
          { schemaVersion: 1, outcome: 'retest_requested' },
          { testerRequired: true, testerRetriesRemaining: 0 },
        );
        expect(disposition.kind).toBe('control-invalid');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('reviewing');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('records a human decision without publishing when publication is unavailable', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('human');
      try {
        yield* seedReviewing(fixture.runDirectory, { runtimeValidationRequired: false });
        const disposition = yield* handle(
          fixture.runDirectory,
          {
            schemaVersion: 1,
            outcome: 'human_decision_required',
            decision: {
              question: 'Should the stricter bound remain?',
              options: [
                { label: 'Keep it', action: 'accept' },
                { label: 'Relax it', action: 'correct' },
              ],
            },
          },
          { publicationEligible: false },
        );
        expect(disposition.kind).toBe('blocked');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('blocked');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('enters publishing for an eligible human decision without opening a PR here', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('human-eligible');
      try {
        yield* seedReviewing(fixture.runDirectory, { runtimeValidationRequired: false });
        const disposition = yield* handle(
          fixture.runDirectory,
          {
            schemaVersion: 1,
            outcome: 'human_decision_required',
            decision: {
              question: 'Should the stricter bound remain?',
              options: [
                { label: 'Keep it', action: 'accept' },
                { label: 'Relax it', action: 'correct' },
              ],
            },
          },
          { publicationEligible: true },
        );
        expect(disposition).toEqual({ kind: 'human-decision-required' });
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('publishing');
        expect(after.derived.verifications.length).toBeGreaterThan(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('operational problems block instead of speculating a decision', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('blocked');
      try {
        yield* seedReviewing(fixture.runDirectory, { runtimeValidationRequired: false });
        const disposition = yield* handle(fixture.runDirectory, {
          schemaVersion: 1,
          outcome: 'blocked',
        });
        expect(disposition.kind).toBe('blocked');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('blocked');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
