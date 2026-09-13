import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunGit } from '../src/application/git-provisioning/index.js';
import {
  HANDOFF_FILENAME,
  HandoffDocumentSchema,
  buildHandoff,
  completionOf,
  reconcileHandoff,
} from '../src/application/handoff/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { transitionWorkflow } from '../src/application/workflow-transitions/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';

import type { ImplementationObservation } from '../src/application/git-provisioning/index.js';
import type { PlanAcceptedPayload, RunHistoryDerivedState } from '../src/domain/run-history.js';
import type { RoleHostControl } from '../src/domain/role-host.js';
import type { WorkflowTransitionRequest } from '../src/domain/workflow.js';

const RUN_ID = 'RUN-HANDOFF';

const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const RESULT_COMMIT = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

const TASK_BRANCH = 'foundry/RUN-HANDOFF';

const WORKSPACE = '/target/.agent/worktrees/RUN-HANDOFF';

const PROFILE_HASH = 'a'.repeat(64);

const IMPLEMENTED: ImplementationObservation = {
  workspaceExists: true,
  currentBranch: TASK_BRANCH,
  headCommit: RESULT_COMMIT,
  clean: true,
  baseIsAncestor: true,
  changedFiles: ['src/domain/thing.ts', 'tests/thing.test.ts'],
};

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-handoff-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function observingGit(observation: ImplementationObservation): Layer.Layer<RunGit> {
  const unused = (name: string) => Effect.die(new Error(`handoff tests must not call ${name}`));
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
      observeImplementation: () => Effect.succeed(observation),
    }),
  );
}

function seedBase(fixture: Fixture) {
  const { runDirectory } = fixture;
  return Effect.gen(function* () {
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: true,
      build: () =>
        Effect.succeed({ type: 'run-created', payload: { taskId: 'TASK-HANDOFF' } as const }),
    });
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'source-frozen',
          payload: {
            repository: {
              repositoryRoot: '/target',
              gitDirectory: '/target/.git',
              remoteUrl: 'https://example.invalid/target.git',
            },
            sourceRemote: 'origin',
            sourceBranch: 'main',
            sourceCommit: SOURCE_COMMIT,
            taskBranch: TASK_BRANCH,
            workspace: WORKSPACE,
            expectedHead: SOURCE_COMMIT,
          },
        } as const),
    });
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'guidance-frozen',
          payload: {
            sourceCommit: SOURCE_COMMIT,
            manifestPath: 'guidance-manifest.json',
            aggregateHash: 'f'.repeat(64),
            files: [],
          },
        } as const),
    });
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'worktree-ready',
          payload: {
            taskBranch: TASK_BRANCH,
            workspace: WORKSPACE,
            headCommit: SOURCE_COMMIT,
            baseCommit: SOURCE_COMMIT,
          },
        } as const),
    });
    yield* transition(fixture, {
      route: 'run-created',
      provisioning: { source: true, lease: true, storage: true, worktree: true },
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function transition(fixture: Fixture, request: WorkflowTransitionRequest) {
  return transitionWorkflow({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    request,
  }).pipe(Effect.provide(observingGit(IMPLEMENTED)), Effect.provide(RunHistoryLive));
}

function appendAcceptedPlan(fixture: Fixture, plan: PlanAcceptedPayload) {
  return appendRunEvent({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
    build: () => Effect.succeed({ type: 'plan-accepted', payload: plan } as const),
  }).pipe(Effect.provide(RunHistoryLive));
}

function appendVerification(fixture: Fixture, commit: string) {
  return appendRunEvent({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'verification-completed',
        payload: {
          attempt: 1,
          repository: '/target/.agent/worktrees/RUN-HANDOFF',
          commit,
          profileHash: PROFILE_HASH,
          commandMs: 1000,
          executions: [
            {
              kind: 'gate' as const,
              name: 'typecheck',
              executable: 'npm',
              arguments: ['run', 'typecheck'],
              expectedExitCode: 0,
              actualExitCode: 0,
              timedOut: false,
              durationMs: 900,
              log: {
                path: 'logs/typecheck.log',
                sha256: 'b'.repeat(64),
                byteLength: 10,
                retainedByteLength: 10,
                truncated: false,
                redactionCount: 0,
              },
              trackedMutation: null,
              reconstructed: false,
              reconstructionError: null,
            },
          ],
          result: 'passed' as const,
        },
      } as const),
  }).pipe(Effect.provide(RunHistoryLive));
}

function appendTesterSkip(fixture: Fixture, commit: string) {
  return appendRunEvent({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'tester-skipped',
        payload: {
          reason: 'The accepted plan does not require live application validation.',
          verificationCommit: commit,
        },
      } as const),
  }).pipe(Effect.provide(RunHistoryLive));
}

function seedRoleSession(
  fixture: Fixture,
  role: 'tester' | 'reviewer',
  narrative: string,
  control: RoleHostControl,
) {
  const { runDirectory } = fixture;
  const sessionId = `session-${role}-1`;
  const runtimeIdentity = {
    adapterVersion: 'scripted-1',
    provider: 'scripted',
    model: 'scripted',
    toolProfile: 'scripted',
  };
  return Effect.gen(function* () {
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'role-session-created',
          payload: {
            role,
            attempt: 1,
            generation: 1,
            sessionId,
            ownershipToken: `owner-${sessionId}`,
            sequence: 0,
            runtimeIdentity,
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
          type: 'role-session-submission-requested',
          payload: {
            sessionId,
            generation: 1,
            kind: 'initial' as const,
            idempotencyKey: `${sessionId}-submission`,
            promptHash: PROFILE_HASH,
            baselineSequence: 0,
          },
        } as const),
    });
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'role-session-submission-started',
          payload: {
            sessionId,
            generation: 1,
            idempotencyKey: `${sessionId}-submission`,
            submission: 'accepted' as const,
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
            sessionId,
            generation: 1,
            status: 'settled' as const,
            sequence: 1,
            eventCount: 1,
            narrative,
            control,
          },
        } as const),
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

const CHANGE_PLAN: PlanAcceptedPayload = {
  outcome: 'plan_ready',
  criteria: [
    { id: 'AC-001', text: 'the change is observable' },
    { id: 'AC-002', text: 'the checks pass' },
  ],
  runtimeValidationRequired: false,
  execution: {
    mode: 'sequential',
    objectives: [
      {
        id: 'OBJ-001',
        title: 'Implement the change',
        affectedPaths: ['src/'],
        criterionIds: ['AC-001', 'AC-002'],
      },
    ],
  },
};

const NO_CHANGE_PLAN: PlanAcceptedPayload = {
  outcome: 'no_change_candidate',
  criteria: [{ id: 'AC-001', text: 'the source already satisfies the request' }],
  runtimeValidationRequired: false,
  execution: {
    mode: 'sequential',
    objectives: [
      {
        id: 'OBJ-001',
        title: 'Confirm the source already satisfies the request',
        affectedPaths: ['.'],
        criterionIds: ['AC-001'],
      },
    ],
  },
};

function seedChangeToCompletion(fixture: Fixture) {
  return Effect.gen(function* () {
    yield* seedBase(fixture);
    yield* appendAcceptedPlan(fixture, CHANGE_PLAN);
    yield* transition(fixture, { route: 'plan-accepted' });
    yield* transition(fixture, {
      route: 'implementation-ready',
      branchClean: true,
      candidateCommit: null,
      noChangeCandidateValidated: false,
    });
    yield* appendVerification(fixture, RESULT_COMMIT);
    yield* appendTesterSkip(fixture, RESULT_COMMIT);
    yield* seedRoleSession(fixture, 'reviewer', 'Reviewer approved the exact result.', {
      schemaVersion: 1,
      outcome: 'approved',
    });
    yield* transition(fixture, {
      route: 'checks-passed-reviewing',
      checksPassed: true,
      correctionBudgetExhausted: false,
      reviewableCommit: RESULT_COMMIT,
    });
    yield* transition(fixture, {
      route: 'review-approved',
      approvedCommit: RESULT_COMMIT,
      evidenceCommitMatches: true,
      checksPassed: true,
      testerRequired: false,
      runtimeEvidencePresent: true,
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function seedNoChangeToCompletion(fixture: Fixture) {
  return Effect.gen(function* () {
    yield* seedBase(fixture);
    yield* appendAcceptedPlan(fixture, NO_CHANGE_PLAN);
    yield* appendRunEvent({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'implementation-accepted',
          payload: {
            taskBranch: TASK_BRANCH,
            baseCommit: SOURCE_COMMIT,
            commit: null,
            changedFiles: [],
            noChangeCandidate: true,
          },
        } as const),
    });
    yield* transition(fixture, { route: 'plan-no-change' });
    yield* appendVerification(fixture, SOURCE_COMMIT);
    yield* appendTesterSkip(fixture, SOURCE_COMMIT);
    yield* seedRoleSession(
      fixture,
      'reviewer',
      'The verified source already satisfies the request.',
      {
        schemaVersion: 1,
        outcome: 'approved',
      },
    );
    yield* transition(fixture, {
      route: 'checks-passed-reviewing',
      checksPassed: true,
      correctionBudgetExhausted: false,
      reviewableCommit: SOURCE_COMMIT,
    });
    yield* transition(fixture, {
      route: 'review-approved-no-change',
      verifiedSourceApproved: true,
      implementationCommit: null,
      checksPassed: true,
      evidenceCommitMatches: true,
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function reconcile(fixture: Fixture) {
  return reconcileHandoff({ runDirectory: fixture.runDirectory, runId: RUN_ID }).pipe(
    Effect.provide(RunHistoryLive),
  );
}

const HandoffDocumentJson = Schema.fromJsonString(HandoffDocumentSchema);

function readHandoff(fixture: Fixture) {
  const text = readFileSync(join(fixture.runDirectory, HANDOFF_FILENAME), 'utf8');
  return Schema.decodeUnknownSync(HandoffDocumentJson)(text);
}

function emptyDerived(): RunHistoryDerivedState {
  return {
    state: 'completed',
    checkpoint: null,
    attempts: [],
    cleanupProgress: null,
    sourceFrozen: null,
    guidanceFrozen: null,
    worktreeReady: null,
    roleSessions: [],
    roleControlRepairs: [],
    acceptedPlan: null,
    findings: [],
    implementation: null,
    permissionViolations: [],
    verifications: [],
    testerSkips: [],
    validationLimitations: [],
    runtimeLifecycles: [],
  };
}

describe('canonical handoff for completed runs', () => {
  it.effect('records a change handoff that agrees with the accepted result', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedChangeToCompletion(fixture);
        const result = yield* reconcile(fixture);
        expect(result).not.toBeNull();

        const document = readHandoff(fixture);
        expect(document.kind).toBe('change');
        expect(document.outcome).toBe('completed');
        expect(document.source?.commit).toBe(SOURCE_COMMIT);
        expect(document.resultCommit).toBe(RESULT_COMMIT);
        expect(document.verifiedCommit).toBe(RESULT_COMMIT);
        expect(document.changedFiles).toEqual(['src/domain/thing.ts', 'tests/thing.test.ts']);
        expect(document.plan?.criteria.map((criterion) => criterion.id)).toEqual([
          'AC-001',
          'AC-002',
        ]);
        expect(document.checks).toHaveLength(1);
        expect(document.checks[0]?.name).toBe('typecheck');
        expect(document.tester.status).toBe('skipped');
        expect(document.reviewer?.outcome).toBe('approved');
        expect(document.reviewer?.narrative).toBe('Reviewer approved the exact result.');
        expect(document.humanDecision.applied).toBe(false);
        expect(document.publication.created).toBe(false);
        expect(document.coverageComplete).toBe(true);
        expect(document.missingCoverage).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('records a no-change handoff without a Coder commit or fabricated PR', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedNoChangeToCompletion(fixture);
        const result = yield* reconcile(fixture);
        expect(result).not.toBeNull();

        const document = readHandoff(fixture);
        expect(document.kind).toBe('no_change');
        expect(document.outcome).toBe('completed_no_change');
        expect(document.resultCommit).toBeNull();
        expect(document.verifiedCommit).toBe(SOURCE_COMMIT);
        expect(document.changedFiles).toEqual([]);
        expect(document.publication.created).toBe(false);
        expect(document.publication.reason).toContain('no-change');
        expect(document.coverageComplete).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('reconciles the same handoff bytes on repeated settles', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedChangeToCompletion(fixture);
        yield* reconcile(fixture);
        const first = readFileSync(join(fixture.runDirectory, HANDOFF_FILENAME));
        yield* reconcile(fixture);
        const second = readFileSync(join(fixture.runDirectory, HANDOFF_FILENAME));
        expect(Buffer.compare(first, second)).toBe(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('stays absent and does not infer success for a nonterminal run', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedBase(fixture);
        const result = yield* reconcile(fixture);
        expect(result).toBeNull();
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('handoff completeness diagnostics', () => {
  it.effect('calls out absent promised coverage instead of looking complete', () =>
    Effect.sync(() => {
      expect(completionOf([])).toBeNull();

      const document = buildHandoff(
        RUN_ID,
        emptyDerived(),
        {
          state: 'completed',
          route: 'review-approved',
          from: 'reviewing',
          at: '2026-01-01T00:00:00.000Z',
        },
        [],
      );
      expect(document.coverageComplete).toBe(false);
      expect(document.missingCoverage).toContain('The frozen source record is unavailable.');
      expect(document.missingCoverage).toContain('The accepted plan is unavailable.');
      expect(document.missingCoverage).toContain(
        'The completed change has no recorded Coder result commit.',
      );
      expect(document.missingCoverage).toContain('The Reviewer outcome is unavailable.');
    }),
  );

  it.effect('derives the completion instant from the terminal transition', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedChangeToCompletion(fixture);
        const history = yield* readVerifiedRunHistory({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(RunHistoryLive));
        const completion = completionOf(history.events);
        expect(completion?.state).toBe('completed');
        expect(completion?.route).toBe('review-approved');
        expect(completion?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('handoff role summaries', () => {
  const completion = {
    state: 'completed' as const,
    route: 'review-approved' as const,
    from: 'reviewing' as const,
    at: '2026-01-01T00:00:00.000Z',
  };

  const implementation = {
    taskBranch: TASK_BRANCH,
    baseCommit: SOURCE_COMMIT,
    commit: RESULT_COMMIT,
    changedFiles: ['src/domain/thing.ts'],
    noChangeCandidate: false,
  };

  const reviewerSession = {
    role: 'reviewer' as const,
    attempt: 1,
    generation: 1,
    sessionId: 'session-reviewer-1',
    ownershipToken: 'owner-session-reviewer-1',
    initialSequence: 0,
    runtimeIdentity: {
      adapterVersion: 'scripted-1',
      provider: 'scripted',
      model: 'scripted',
      toolProfile: 'scripted',
    },
    workingDirectory: null,
    submission: null,
    submissionStarted: null,
    stopDisposition: null,
    lastObservation: {
      status: 'settled' as const,
      sequence: 1,
      eventCount: 1,
      narrative: 'Reviewer prose without a valid control envelope.',
      control: { outcome: 'approved' },
    },
  };

  it.effect('keeps reviewer narrative but not outcome when control decoding fails', () =>
    Effect.sync(() => {
      const document = buildHandoff(
        RUN_ID,
        {
          ...emptyDerived(),
          acceptedPlan: CHANGE_PLAN,
          implementation,
          roleSessions: [reviewerSession],
        },
        completion,
        [],
      );

      expect(document.reviewer?.outcome).toBeNull();
      expect(document.reviewer?.narrative).toBe('Reviewer prose without a valid control envelope.');
    }),
  );

  it.effect('records tester limitation evidence for the verified commit', () =>
    Effect.sync(() => {
      const document = buildHandoff(
        RUN_ID,
        {
          ...emptyDerived(),
          acceptedPlan: { ...CHANGE_PLAN, runtimeValidationRequired: true },
          implementation,
          validationLimitations: [
            {
              reason: 'The prepared application runtime could not be observed read-only.',
              commit: RESULT_COMMIT,
            },
          ],
        },
        completion,
        [],
      );

      expect(document.tester.status).toBe('limitation');
      expect(document.tester.detail).toContain('could not be observed read-only');
      expect(document.tester.commit).toBe(RESULT_COMMIT);
    }),
  );

  it.effect('distinguishes required-tester missing evidence from an explicit skip', () =>
    Effect.sync(() => {
      const missing = buildHandoff(
        RUN_ID,
        {
          ...emptyDerived(),
          acceptedPlan: { ...CHANGE_PLAN, runtimeValidationRequired: true },
          implementation,
        },
        completion,
        [],
      );
      expect(missing.tester.status).toBe('missing');
      expect(missing.tester.detail).toContain('required live application validation');

      const skipped = buildHandoff(
        RUN_ID,
        {
          ...emptyDerived(),
          acceptedPlan: CHANGE_PLAN,
          implementation,
          testerSkips: [
            {
              reason: 'The accepted plan does not require live application validation.',
              verificationCommit: RESULT_COMMIT,
            },
          ],
        },
        completion,
        [],
      );
      expect(skipped.tester.status).toBe('skipped');
      expect(skipped.tester.detail).toContain('does not require live application validation');
    }),
  );
});
