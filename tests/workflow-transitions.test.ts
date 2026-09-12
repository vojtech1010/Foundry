import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IllegalWorkflowAttempt,
  IllegalWorkflowTransition,
  recordCleanupProgress,
  recordWorkflowAttempt,
  transitionWorkflow,
} from '../src/application/workflow-transitions/index.js';
import {
  CLEANUP_PROGRESS_FILENAME,
  CLEANUP_PROGRESS_SCHEMA_VERSION,
  CleanupProgressDocumentSchema,
  WORKFLOW_STATE_FILENAME,
  WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
  WORKFLOW_TRANSITION_ROUTES,
  WORKFLOW_TRANSITION_ROUTE_KINDS,
  WorkflowProgressDocumentSchema,
  WorkflowStateRecordSchema,
} from '../src/domain/workflow.js';
import { RUN_HISTORY_FILENAME, RunEventSchema } from '../src/domain/run-history.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';

import type { RunEvent } from '../src/domain/run-history.js';
import type { RunHistoryError } from '../src/application/run-history/index.js';
import type {
  WorkflowAttemptRequest,
  WorkflowState,
  WorkflowTransitionRequest,
  WorkflowTransitionRouteKind,
} from '../src/domain/workflow.js';
import type {
  RunIdentityStorageError,
  RunStateUnavailable,
} from '../src/application/run-identity/index.js';

const RUN_ID = 'RUN-LEGAL';

const LiveStore = Layer.mergeAll(RunIdentityLive, RunHistoryLive);

const REVIEW_APPROVAL: WorkflowTransitionRequest = {
  route: 'review-approved',
  approvedCommit: 'abc123',
  evidenceCommitMatches: true,
  checksPassed: true,
  testerRequired: true,
  runtimeEvidencePresent: true,
};

const RUN_CREATED: WorkflowTransitionRequest = {
  route: 'run-created',
  provisioning: { source: true, lease: true, storage: true, worktree: true },
};

const PLAN_ACCEPTED: WorkflowTransitionRequest = {
  route: 'plan-accepted',
  planRequiresImplementation: true,
};

const IMPLEMENTATION_READY: WorkflowTransitionRequest = {
  route: 'implementation-ready',
  branchClean: true,
  candidateCommit: 'seed-commit',
  noChangeCandidateValidated: false,
};

const CHECKS_PASSED_TESTING: WorkflowTransitionRequest = {
  route: 'checks-passed-testing',
  checksPassed: true,
  runtimeValidationRequired: true,
};

const CHECKS_PASSED_REVIEWING: WorkflowTransitionRequest = {
  route: 'checks-passed-reviewing',
  checksPassed: true,
  testerRequired: false,
  correctionBudgetExhausted: false,
  reviewableCommit: 'seed-commit',
};

const PUBLICATION_UNAVAILABLE: WorkflowTransitionRequest = {
  route: 'publication-unavailable',
  envelopeValid: true,
  publicationEligible: false,
};

const PUBLICATION_UNRESOLVED: WorkflowTransitionRequest = {
  route: 'publication-unresolved',
  cannotReconcileSafely: true,
};

const HUMAN_DECISION_REQUIRED: WorkflowTransitionRequest = {
  route: 'human-decision-required',
  envelopeValid: true,
  reviewableChangedCommit: 'seed-commit',
  noChangeCandidate: false,
};

const DRAFT_PR_RECONCILED: WorkflowTransitionRequest = {
  route: 'draft-pr-reconciled',
  draftPrUrl: 'https://github.com/example/repo/pull/1',
};

const SEED_ROUTES: Readonly<Record<WorkflowState, ReadonlyArray<WorkflowTransitionRequest>>> = {
  planning: [],
  coding: [PLAN_ACCEPTED],
  verifying: [PLAN_ACCEPTED, IMPLEMENTATION_READY],
  testing: [PLAN_ACCEPTED, IMPLEMENTATION_READY, CHECKS_PASSED_TESTING],
  reviewing: [PLAN_ACCEPTED, IMPLEMENTATION_READY, CHECKS_PASSED_REVIEWING],
  correcting: [
    PLAN_ACCEPTED,
    IMPLEMENTATION_READY,
    CHECKS_PASSED_REVIEWING,
    { route: 'correction-required', findingsBacked: true, correctionRoundsRemaining: 1 },
  ],
  human_decision_required: [
    PLAN_ACCEPTED,
    IMPLEMENTATION_READY,
    CHECKS_PASSED_REVIEWING,
    HUMAN_DECISION_REQUIRED,
    DRAFT_PR_RECONCILED,
  ],
  publishing: [
    PLAN_ACCEPTED,
    IMPLEMENTATION_READY,
    CHECKS_PASSED_REVIEWING,
    HUMAN_DECISION_REQUIRED,
  ],
  completed: [PLAN_ACCEPTED, IMPLEMENTATION_READY, CHECKS_PASSED_REVIEWING, REVIEW_APPROVAL],
  completed_no_change: [
    PLAN_ACCEPTED,
    IMPLEMENTATION_READY,
    CHECKS_PASSED_REVIEWING,
    {
      route: 'review-approved-no-change',
      verifiedSourceApproved: true,
      implementationCommit: null,
    },
  ],
  abandoned: [{ route: 'abandon-run', explicitRequest: true, reason: 'seeded' }],
  blocked: [{ route: 'block-run', recoverablePrerequisite: true, reason: 'seeded' }],
  failed: [{ route: 'fail-run', validatedFailure: true, reason: 'seeded' }],
  publish_failed: [
    PLAN_ACCEPTED,
    IMPLEMENTATION_READY,
    CHECKS_PASSED_REVIEWING,
    HUMAN_DECISION_REQUIRED,
    PUBLICATION_UNRESOLVED,
  ],
};

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-workflow-transitions-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function seedRun(fixture: Fixture, state: WorkflowState) {
  return Effect.gen(function* () {
    yield* transitionWorkflow({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      request: RUN_CREATED,
    });
    for (const request of SEED_ROUTES[state]) {
      yield* transitionWorkflow({
        runDirectory: fixture.runDirectory,
        runId: RUN_ID,
        request,
      });
    }
  }).pipe(Effect.provide(LiveStore));
}

function transition(fixture: Fixture, request: WorkflowTransitionRequest) {
  return transitionWorkflow({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    request,
  }).pipe(Effect.provide(LiveStore));
}

function recordAttempt(fixture: Fixture, attempt: WorkflowAttemptRequest) {
  return recordWorkflowAttempt({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    attempt,
  }).pipe(Effect.provide(LiveStore));
}

function stateTextOf(fixture: Fixture): string {
  return readFileSync(join(fixture.runDirectory, WORKFLOW_STATE_FILENAME), 'utf8');
}

function historyTextOf(fixture: Fixture): string {
  return readFileSync(join(fixture.runDirectory, RUN_HISTORY_FILENAME), 'utf8');
}

const RunEventJson = Schema.fromJsonString(RunEventSchema);

function historyEventsOf(fixture: Fixture): ReadonlyArray<RunEvent> {
  const lines = historyTextOf(fixture).split('\n');
  lines.pop();
  return lines.map((line) =>
    Schema.decodeUnknownSync(RunEventJson, { onExcessProperty: 'error' })(line),
  );
}

function progressDocument(fixture: Fixture) {
  return Schema.decodeUnknownSync(WorkflowProgressDocumentSchema, { onExcessProperty: 'error' })(
    JSON.parse(stateTextOf(fixture)),
  );
}

type TransitionFailure =
  | IllegalWorkflowTransition
  | RunStateUnavailable
  | RunIdentityStorageError
  | RunHistoryError;

type AttemptFailure =
  | IllegalWorkflowAttempt
  | RunStateUnavailable
  | RunIdentityStorageError
  | RunHistoryError;

function expectTransitionRefusal(error: TransitionFailure): IllegalWorkflowTransition {
  expect(error).toBeInstanceOf(IllegalWorkflowTransition);
  if (!(error instanceof IllegalWorkflowTransition)) {
    throw new Error('Expected an IllegalWorkflowTransition.');
  }
  return error;
}

function expectAttemptRefusal(error: AttemptFailure): IllegalWorkflowAttempt {
  expect(error).toBeInstanceOf(IllegalWorkflowAttempt);
  if (!(error instanceof IllegalWorkflowAttempt)) {
    throw new Error('Expected an IllegalWorkflowAttempt.');
  }
  return error;
}

function refusalText(refusal: IllegalWorkflowTransition): string {
  return `${refusal.missingFact ?? ''} | ${refusal.reason}`;
}

describe('legal transition route contract', () => {
  it('enumerates every documented route and target', () => {
    const routes: ReadonlyArray<readonly [WorkflowTransitionRouteKind, string, string]> = [
      ['run-created', 'creation', 'planning'],
      ['plan-accepted', 'planning', 'coding'],
      ['plan-no-change', 'planning', 'verifying'],
      ['implementation-ready', 'coding,correcting', 'verifying'],
      ['checks-passed-testing', 'verifying', 'testing'],
      ['checks-passed-reviewing', 'verifying', 'reviewing'],
      ['correction-required', 'verifying,testing,reviewing', 'correcting'],
      ['tester-settled', 'testing', 'reviewing'],
      ['retest-requested', 'reviewing', 'testing'],
      ['review-approved', 'reviewing', 'completed'],
      ['review-approved-no-change', 'reviewing', 'completed_no_change'],
      ['human-decision-required', 'reviewing', 'publishing'],
      ['publication-unavailable', 'reviewing', 'blocked'],
      ['draft-pr-reconciled', 'publishing', 'human_decision_required'],
      ['publication-unresolved', 'publishing', 'publish_failed'],
      ['human-accepted', 'human_decision_required', 'completed'],
      ['human-corrected', 'human_decision_required', 'correcting'],
      ['abandon-run', 'nonterminal', 'abandoned'],
      ['block-run', 'active', 'blocked'],
      ['fail-run', 'active', 'failed'],
      ['resume', 'blocked,publish_failed', 'recorded-checkpoint'],
    ];

    expect(WORKFLOW_TRANSITION_ROUTE_KINDS).toEqual(routes.map(([route]) => route));
    for (const [route, from, to] of routes) {
      const definition = WORKFLOW_TRANSITION_ROUTES[route];
      expect(definition.to, route).toBe(to);
      if (from === 'creation' || from === 'nonterminal' || from === 'active') {
        expect(definition.from, route).toBe(from);
      } else {
        expect(definition.from, route).toEqual(from.split(','));
      }
    }
  });

  it('decodes version 2 progress records and rejects malformed ones', () => {
    const decode = (value: Schema.Json) =>
      Schema.decodeUnknownSync(WorkflowStateRecordSchema, { onExcessProperty: 'error' })(value);
    const progress = {
      schemaVersion: WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
      runId: RUN_ID,
      state: 'reviewing',
      checkpoint: 'reviewing',
      attempts: [{ sequence: 1, kind: 'retry', role: 'coder', state: 'coding', reason: 'again' }],
    };
    expect(decode(progress)).toEqual(progress);
    expect(() => decode({ ...progress, state: 'queued' })).toThrow();
    expect(() => decode({ ...progress, checkpoint: null, attempts: 'none' })).toThrow();
    expect(() =>
      decode({
        ...progress,
        attempts: [{ sequence: 1, kind: 'unknown', role: 'coder', state: 'coding', reason: 'x' }],
      }),
    ).toThrow();
  });
});

describe('workflow transitions with live storage', () => {
  it.effect('creates planning only with durable provisioning checkpoints', () =>
    Effect.gen(function* () {
      const missing = setupFixture();
      try {
        const error = yield* transition(missing, {
          route: 'run-created',
          provisioning: { source: true, lease: true, storage: true, worktree: false },
        }).pipe(Effect.flip);
        const refusal = expectTransitionRefusal(error);
        expect(refusal.from).toBeNull();
        expect(refusal.to).toBe('planning');
        expect(refusal.missingFact).toContain('worktree');
        expect(existsSync(join(missing.runDirectory, WORKFLOW_STATE_FILENAME))).toBe(false);
        expect(existsSync(join(missing.runDirectory, RUN_HISTORY_FILENAME))).toBe(false);
      } finally {
        missing.cleanup();
      }

      const created = setupFixture();
      try {
        const report = yield* transition(created, RUN_CREATED);
        expect(report).toEqual({
          runId: RUN_ID,
          route: 'run-created',
          previousState: null,
          workflowState: 'planning',
        });
        expect(progressDocument(created)).toEqual({
          schemaVersion: WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
          runId: RUN_ID,
          state: 'planning',
          checkpoint: null,
          attempts: [],
        });
        const events = historyEventsOf(created);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          revision: 1,
          previousEventHash: null,
          type: 'workflow-transition',
          payload: {
            route: 'run-created',
            from: null,
            to: 'planning',
            checkpoint: null,
          },
        });

        const alreadyCreated = yield* transition(created, RUN_CREATED).pipe(Effect.flip);
        expect(expectTransitionRefusal(alreadyCreated).from).toBe('planning');
        expect(historyEventsOf(created)).toHaveLength(1);
      } finally {
        created.cleanup();
      }
    }),
  );

  it.effect('applies every legal route to its documented target', () =>
    Effect.gen(function* () {
      const acceptedRoutes: ReadonlyArray<
        readonly [WorkflowState, WorkflowTransitionRequest, WorkflowState]
      > = [
        ['planning', { route: 'plan-accepted', planRequiresImplementation: true }, 'coding'],
        ['planning', { route: 'plan-no-change', noChangeCandidateAccepted: true }, 'verifying'],
        [
          'coding',
          {
            route: 'implementation-ready',
            branchClean: true,
            candidateCommit: 'abc123',
            noChangeCandidateValidated: false,
          },
          'verifying',
        ],
        [
          'correcting',
          {
            route: 'implementation-ready',
            branchClean: true,
            candidateCommit: null,
            noChangeCandidateValidated: true,
          },
          'verifying',
        ],
        [
          'verifying',
          { route: 'checks-passed-testing', checksPassed: true, runtimeValidationRequired: true },
          'testing',
        ],
        [
          'verifying',
          {
            route: 'checks-passed-reviewing',
            checksPassed: true,
            testerRequired: false,
            correctionBudgetExhausted: false,
            reviewableCommit: 'abc123',
          },
          'reviewing',
        ],
        [
          'verifying',
          {
            route: 'checks-passed-reviewing',
            checksPassed: false,
            testerRequired: true,
            correctionBudgetExhausted: true,
            reviewableCommit: 'abc123',
          },
          'reviewing',
        ],
        [
          'reviewing',
          { route: 'correction-required', findingsBacked: true, correctionRoundsRemaining: 1 },
          'correcting',
        ],
        [
          'testing',
          { route: 'tester-settled', observationsSettled: true, runtimeLimitationRetained: false },
          'reviewing',
        ],
        [
          'testing',
          { route: 'tester-settled', observationsSettled: false, runtimeLimitationRetained: true },
          'reviewing',
        ],
        [
          'reviewing',
          {
            route: 'retest-requested',
            reviewerRequestedRetest: true,
            sameCommit: true,
            testerRetriesRemaining: 1,
          },
          'testing',
        ],
        ['reviewing', REVIEW_APPROVAL, 'completed'],
        [
          'reviewing',
          {
            route: 'review-approved-no-change',
            verifiedSourceApproved: true,
            implementationCommit: null,
          },
          'completed_no_change',
        ],
        [
          'reviewing',
          {
            route: 'human-decision-required',
            envelopeValid: true,
            reviewableChangedCommit: 'abc123',
            noChangeCandidate: false,
          },
          'publishing',
        ],
        [
          'reviewing',
          { route: 'publication-unavailable', envelopeValid: true, publicationEligible: false },
          'blocked',
        ],
        [
          'publishing',
          { route: 'draft-pr-reconciled', draftPrUrl: 'https://github.com/example/repo/pull/1' },
          'human_decision_required',
        ],
        [
          'publishing',
          { route: 'publication-unresolved', cannotReconcileSafely: true },
          'publish_failed',
        ],
        ['human_decision_required', { route: 'human-accepted', authenticated: true }, 'completed'],
        [
          'human_decision_required',
          { route: 'human-corrected', authenticated: true },
          'correcting',
        ],
        [
          'planning',
          { route: 'abandon-run', explicitRequest: true, reason: 'operator ended it' },
          'abandoned',
        ],
        [
          'blocked',
          { route: 'abandon-run', explicitRequest: true, reason: 'operator ended it' },
          'abandoned',
        ],
        [
          'publish_failed',
          { route: 'abandon-run', explicitRequest: true, reason: 'operator ended it' },
          'abandoned',
        ],
        [
          'planning',
          { route: 'block-run', recoverablePrerequisite: true, reason: 'lease repair' },
          'blocked',
        ],
        ['verifying', { route: 'fail-run', validatedFailure: true, reason: 'no result' }, 'failed'],
      ];

      for (const [state, request, target] of acceptedRoutes) {
        const fixture = setupFixture();
        try {
          yield* seedRun(fixture, state);
          const report = yield* transition(fixture, request);
          expect(report.previousState, `${state}:${request.route}`).toBe(state);
          expect(report.workflowState, `${state}:${request.route}`).toBe(target);
        } finally {
          fixture.cleanup();
        }
      }
    }),
  );

  it.effect('refuses illegal jumps and missing facts without changing the record', () =>
    Effect.gen(function* () {
      const refusedRoutes: ReadonlyArray<
        readonly [string, WorkflowState, WorkflowTransitionRequest, string]
      > = [
        [
          'unproven implementation plan',
          'planning',
          { route: 'plan-accepted', planRequiresImplementation: false },
          'implementation',
        ],
        [
          'unproven no-change plan',
          'planning',
          { route: 'plan-no-change', noChangeCandidateAccepted: false },
          'no-change candidate',
        ],
        [
          'dirty branch',
          'coding',
          {
            route: 'implementation-ready',
            branchClean: false,
            candidateCommit: 'abc123',
            noChangeCandidateValidated: false,
          },
          'clean',
        ],
        [
          'no candidate commit',
          'coding',
          {
            route: 'implementation-ready',
            branchClean: true,
            candidateCommit: null,
            noChangeCandidateValidated: false,
          },
          'candidate commit',
        ],
        [
          'failed checks before testing',
          'verifying',
          { route: 'checks-passed-testing', checksPassed: false, runtimeValidationRequired: true },
          'checks',
        ],
        [
          'runtime validation not required',
          'verifying',
          { route: 'checks-passed-testing', checksPassed: true, runtimeValidationRequired: false },
          'runtime validation',
        ],
        [
          'failed checks without exhausted budget',
          'verifying',
          {
            route: 'checks-passed-reviewing',
            checksPassed: false,
            testerRequired: true,
            correctionBudgetExhausted: false,
            reviewableCommit: 'abc123',
          },
          'checks',
        ],
        [
          'exhausted budget without reviewable commit',
          'verifying',
          {
            route: 'checks-passed-reviewing',
            checksPassed: true,
            testerRequired: true,
            correctionBudgetExhausted: true,
            reviewableCommit: null,
          },
          'reviewable commit',
        ],
        [
          'exhausted correction budget',
          'reviewing',
          { route: 'correction-required', findingsBacked: true, correctionRoundsRemaining: 0 },
          'correction round',
        ],
        [
          'findings without evidence',
          'reviewing',
          { route: 'correction-required', findingsBacked: false, correctionRoundsRemaining: 1 },
          'evidence-backed',
        ],
        [
          'unsettled observations',
          'testing',
          { route: 'tester-settled', observationsSettled: false, runtimeLimitationRetained: false },
          'settled',
        ],
        [
          'retest against another commit',
          'reviewing',
          {
            route: 'retest-requested',
            reviewerRequestedRetest: true,
            sameCommit: false,
            testerRetriesRemaining: 1,
          },
          'same commit',
        ],
        [
          'no Tester retry',
          'reviewing',
          {
            route: 'retest-requested',
            reviewerRequestedRetest: true,
            sameCommit: true,
            testerRetriesRemaining: 0,
          },
          'retry',
        ],
        [
          'approval without a changed commit',
          'reviewing',
          {
            route: 'review-approved',
            approvedCommit: null,
            evidenceCommitMatches: true,
            checksPassed: true,
            testerRequired: false,
            runtimeEvidencePresent: false,
          },
          'exact changed commit',
        ],
        [
          'approval with stale evidence',
          'reviewing',
          {
            route: 'review-approved',
            approvedCommit: 'abc123',
            evidenceCommitMatches: false,
            checksPassed: true,
            testerRequired: false,
            runtimeEvidencePresent: false,
          },
          'commit-bound evidence',
        ],
        [
          'approval after failed checks',
          'reviewing',
          {
            route: 'review-approved',
            approvedCommit: 'abc123',
            evidenceCommitMatches: true,
            checksPassed: false,
            testerRequired: false,
            runtimeEvidencePresent: false,
          },
          'checks',
        ],
        [
          'approval without runtime evidence',
          'reviewing',
          {
            route: 'review-approved',
            approvedCommit: 'abc123',
            evidenceCommitMatches: true,
            checksPassed: true,
            testerRequired: true,
            runtimeEvidencePresent: false,
          },
          'runtime evidence',
        ],
        [
          'unapproved no-change completion',
          'reviewing',
          {
            route: 'review-approved-no-change',
            verifiedSourceApproved: false,
            implementationCommit: null,
          },
          'already satisfies',
        ],
        [
          'no-change completion of a changed result',
          'reviewing',
          {
            route: 'review-approved-no-change',
            verifiedSourceApproved: true,
            implementationCommit: 'abc123',
          },
          'implementation commit',
        ],
        [
          'invalid decision envelope',
          'reviewing',
          {
            route: 'human-decision-required',
            envelopeValid: false,
            reviewableChangedCommit: 'abc123',
            noChangeCandidate: false,
          },
          'envelope',
        ],
        [
          'no-change decision pull request',
          'reviewing',
          {
            route: 'human-decision-required',
            envelopeValid: true,
            reviewableChangedCommit: 'abc123',
            noChangeCandidate: true,
          },
          'no-change candidate',
        ],
        [
          'decision without a changed commit',
          'reviewing',
          {
            route: 'human-decision-required',
            envelopeValid: true,
            reviewableChangedCommit: null,
            noChangeCandidate: false,
          },
          'reviewable changed commit',
        ],
        [
          'eligible publication cannot block',
          'reviewing',
          { route: 'publication-unavailable', envelopeValid: true, publicationEligible: true },
          'not configured or eligible',
        ],
        [
          'unreconciled draft PR URL',
          'publishing',
          { route: 'draft-pr-reconciled', draftPrUrl: null },
          'draft PR URL',
        ],
        [
          'reconciled publication cannot fail',
          'publishing',
          { route: 'publication-unresolved', cannotReconcileSafely: false },
          'cannot yet be reconciled',
        ],
        [
          'unauthenticated accept',
          'human_decision_required',
          { route: 'human-accepted', authenticated: false },
          'authenticated',
        ],
        [
          'unauthenticated correction',
          'human_decision_required',
          { route: 'human-corrected', authenticated: false },
          'authenticated',
        ],
        [
          'abandonment without a request',
          'planning',
          { route: 'abandon-run', explicitRequest: false, reason: 'stop' },
          'abandonment request',
        ],
        [
          'abandonment without a reason',
          'planning',
          { route: 'abandon-run', explicitRequest: true, reason: '   ' },
          'abandonment reason',
        ],
        [
          'block without a recoverable prerequisite',
          'planning',
          { route: 'block-run', recoverablePrerequisite: false, reason: 'wait' },
          'recoverable prerequisite',
        ],
        [
          'block without a reason',
          'planning',
          { route: 'block-run', recoverablePrerequisite: true, reason: '' },
          'blocking reason',
        ],
        [
          'failure without a validated failure',
          'verifying',
          { route: 'fail-run', validatedFailure: false, reason: 'stop' },
          'validated non-recoverable failure',
        ],
        [
          'failure without a reason',
          'verifying',
          { route: 'fail-run', validatedFailure: true, reason: ' ' },
          'failure reason',
        ],
        ['illegal jump from planning', 'planning', REVIEW_APPROVAL, 'not allowed from'],
        [
          'illegal jump from blocked',
          'blocked',
          { route: 'fail-run', validatedFailure: true, reason: 'stop' },
          'not allowed from',
        ],
        [
          'resume from an active state',
          'coding',
          { route: 'resume', prerequisiteValid: true },
          'not allowed from',
        ],
      ];

      for (const [label, state, request, expected] of refusedRoutes) {
        const fixture = setupFixture();
        try {
          yield* seedRun(fixture, state);
          const before = stateTextOf(fixture);
          const beforeHistory = historyTextOf(fixture);
          const error = yield* transition(fixture, request).pipe(Effect.flip);
          const refusal = expectTransitionRefusal(error);
          expect(refusal.route, label).toBe(request.route);
          expect(refusal.from, label).toBe(state);
          expect(refusalText(refusal), label).toContain(expected);
          expect(stateTextOf(fixture), label).toBe(before);
          expect(historyTextOf(fixture), label).toBe(beforeHistory);
        } finally {
          fixture.cleanup();
        }
      }
    }),
  );

  it.effect('resumes blocked and failed publication only from a recorded checkpoint', () =>
    Effect.gen(function* () {
      const blocked = setupFixture();
      try {
        yield* seedRun(blocked, 'reviewing');
        const report = yield* transition(blocked, PUBLICATION_UNAVAILABLE);
        expect(report.workflowState).toBe('blocked');
        expect(progressDocument(blocked).checkpoint).toBe('reviewing');

        const unproven = yield* transition(blocked, {
          route: 'resume',
          prerequisiteValid: false,
        }).pipe(Effect.flip);
        expect(expectTransitionRefusal(unproven).missingFact).toContain('prerequisite');

        const resumed = yield* transition(blocked, {
          route: 'resume',
          prerequisiteValid: true,
        });
        expect(resumed.workflowState).toBe('reviewing');
        expect(progressDocument(blocked).checkpoint).toBeNull();
      } finally {
        blocked.cleanup();
      }

      const publication = setupFixture();
      try {
        yield* seedRun(publication, 'publishing');
        const failed = yield* transition(publication, PUBLICATION_UNRESOLVED);
        expect(failed.workflowState).toBe('publish_failed');
        expect(progressDocument(publication).checkpoint).toBe('publishing');

        const resumed = yield* transition(publication, {
          route: 'resume',
          prerequisiteValid: true,
        });
        expect(resumed.workflowState).toBe('publishing');
      } finally {
        publication.cleanup();
      }
    }),
  );

  it.effect('rejects every route from terminal states without changing the record', () =>
    Effect.gen(function* () {
      const terminalStates: ReadonlyArray<WorkflowState> = [
        'completed',
        'completed_no_change',
        'failed',
        'abandoned',
      ];
      const requests: ReadonlyArray<WorkflowTransitionRequest> = [
        { route: 'resume', prerequisiteValid: true },
        { route: 'abandon-run', explicitRequest: true, reason: 'stop' },
        { route: 'block-run', recoverablePrerequisite: true, reason: 'wait' },
        { route: 'fail-run', validatedFailure: true, reason: 'stop' },
        REVIEW_APPROVAL,
      ];

      for (const state of terminalStates) {
        const fixture = setupFixture();
        try {
          yield* seedRun(fixture, state);
          const before = stateTextOf(fixture);
          const beforeHistory = historyTextOf(fixture);
          for (const request of requests) {
            const error = yield* transition(fixture, request).pipe(Effect.flip);
            const refusal = expectTransitionRefusal(error);
            expect(refusal.reason, `${state}:${request.route}`).toContain('terminal');
          }
          expect(stateTextOf(fixture)).toBe(before);
          expect(historyTextOf(fixture)).toBe(beforeHistory);
        } finally {
          fixture.cleanup();
        }
      }
    }),
  );

  it.effect('records same-state retries and repairs as distinct attempts', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedRun(fixture, 'planning');
        const emptyReason = yield* recordAttempt(fixture, {
          kind: 'retry',
          role: 'architect',
          reason: '',
          retriesRemaining: 1,
        }).pipe(Effect.flip);
        expect(expectAttemptRefusal(emptyReason).missingFact).toContain('attempt reason');

        const first = yield* recordAttempt(fixture, {
          kind: 'retry',
          role: 'architect',
          reason: 'role timeout',
          retriesRemaining: 1,
        });
        expect(first.workflowState).toBe('planning');
        expect(first.attempt).toEqual({
          sequence: 1,
          kind: 'retry',
          role: 'architect',
          state: 'planning',
          reason: 'role timeout',
        });
        expect(historyEventsOf(fixture)).toHaveLength(2);

        const second = yield* recordAttempt(fixture, {
          kind: 'repair',
          role: 'reviewer',
          reason: 'control envelope invalid',
          repairsRemaining: 1,
        });
        expect(second.attempt.sequence).toBe(2);
        expect(progressDocument(fixture)).toEqual({
          schemaVersion: WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
          runId: RUN_ID,
          state: 'planning',
          checkpoint: null,
          attempts: [first.attempt, second.attempt],
        });
        const events = historyEventsOf(fixture);
        expect(events).toHaveLength(3);
        expect(events[1]).toMatchObject({
          revision: 2,
          type: 'workflow-attempt',
          payload: first.attempt,
        });
        expect(events[2]).toMatchObject({
          revision: 3,
          type: 'workflow-attempt',
          payload: second.attempt,
        });

        const before = stateTextOf(fixture);
        const beforeHistory = historyTextOf(fixture);
        const exhausted = yield* recordAttempt(fixture, {
          kind: 'retry',
          role: 'architect',
          reason: 'one more try',
          retriesRemaining: 0,
        }).pipe(Effect.flip);
        expect(expectAttemptRefusal(exhausted).missingFact).toContain('attempt budget');
        expect(stateTextOf(fixture)).toBe(before);
        expect(historyTextOf(fixture)).toBe(beforeHistory);
      } finally {
        fixture.cleanup();
      }

      const terminal = setupFixture();
      try {
        yield* seedRun(terminal, 'failed');
        const error = yield* recordAttempt(terminal, {
          kind: 'retry',
          role: 'coder',
          reason: 'retry',
          retriesRemaining: 1,
        }).pipe(Effect.flip);
        expect(expectAttemptRefusal(error).reason).toContain('terminal');
      } finally {
        terminal.cleanup();
      }

      const recoverable = setupFixture();
      try {
        yield* seedRun(recoverable, 'blocked');
        const error = yield* recordAttempt(recoverable, {
          kind: 'repair',
          role: 'reviewer',
          reason: 'repair',
          repairsRemaining: 1,
        }).pipe(Effect.flip);
        expect(expectAttemptRefusal(error).missingFact).toContain('active stage');
      } finally {
        recoverable.cleanup();
      }
    }),
  );

  it.effect('evaluates from verified history even when the derived report is hand-edited', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedRun(fixture, 'planning');
        writeFileSync(
          join(fixture.runDirectory, WORKFLOW_STATE_FILENAME),
          `${JSON.stringify(
            {
              schemaVersion: WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
              runId: RUN_ID,
              state: 'reviewing',
              checkpoint: null,
              attempts: [
                {
                  sequence: 7,
                  kind: 'retry',
                  role: 'coder',
                  state: 'reviewing',
                  reason: 'invented by hand',
                },
              ],
            },
            null,
            2,
          )}\n`,
        );

        const error = yield* transition(fixture, REVIEW_APPROVAL).pipe(Effect.flip);
        expect(expectTransitionRefusal(error).from).toBe('planning');

        const attempt = yield* recordAttempt(fixture, {
          kind: 'retry',
          role: 'architect',
          reason: 'from history',
          retriesRemaining: 1,
        });
        expect(attempt.attempt.sequence).toBe(1);

        const report = yield* transition(fixture, PLAN_ACCEPTED);
        expect(report.previousState).toBe('planning');
        expect(progressDocument(fixture)).toEqual({
          schemaVersion: WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
          runId: RUN_ID,
          state: 'coding',
          checkpoint: null,
          attempts: [attempt.attempt],
        });
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('records cleanup progress separately from the accepted result', () =>
    Effect.gen(function* () {
      const outcomes = ['succeeded', 'warning', 'failed'] as const;
      const terminalStates: ReadonlyArray<WorkflowState> = [
        'completed',
        'completed_no_change',
        'failed',
        'abandoned',
      ];

      for (const [index, state] of terminalStates.entries()) {
        const fixture = setupFixture();
        try {
          yield* seedRun(fixture, state);
          const before = stateTextOf(fixture);
          const eventsBefore = historyEventsOf(fixture).length;
          const outcome = outcomes[index % outcomes.length] ?? 'succeeded';
          const report = yield* recordCleanupProgress({
            runDirectory: fixture.runDirectory,
            runId: RUN_ID,
            outcome,
            detail: `cleanup ${outcome}`,
          }).pipe(Effect.provide(LiveStore));

          expect(report.outcome).toBe(outcome);
          expect(report.cleanupProgressPath).toBe(
            join(fixture.runDirectory, CLEANUP_PROGRESS_FILENAME),
          );
          const document = Schema.decodeUnknownSync(CleanupProgressDocumentSchema, {
            onExcessProperty: 'error',
          })(JSON.parse(readFileSync(report.cleanupProgressPath, 'utf8')));
          expect(document).toEqual({
            schemaVersion: CLEANUP_PROGRESS_SCHEMA_VERSION,
            runId: RUN_ID,
            outcome,
            detail: `cleanup ${outcome}`,
          });
          expect(stateTextOf(fixture)).toBe(before);
          const events = historyEventsOf(fixture);
          expect(events).toHaveLength(eventsBefore + 1);
          expect(events[events.length - 1]).toMatchObject({
            type: 'cleanup-progress',
            payload: { outcome, detail: `cleanup ${outcome}` },
          });
        } finally {
          fixture.cleanup();
        }
      }
    }),
  );
});
