import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyRecovery, classifyRoleFailure } from '../src/application/recovery/index.js';
import {
  RunHistoryIntegrityError,
  appendRunEvent,
  readVerifiedRunHistory,
} from '../src/application/run-history/index.js';
import { ROLE_CONVERSATION_FAILURE_REASONS } from '../src/application/role-conversations/index.js';
import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { ProjectCommandProcess } from '../src/application/profile-check/index.js';
import { ReadinessHost } from '../src/application/readiness/index.js';
import { GuidanceLive } from '../src/platform/guidance.js';
import { RunGitLive } from '../src/platform/git-provisioning.js';
import { ProjectCommandsPlatformLive } from '../src/platform/project-commands.js';
import { ReadinessFilesLive, ReadinessGitLive } from '../src/platform/readiness.js';
import { RepositoryLeaseLive } from '../src/platform/repository-lease.js';
import { RoleTurnResourceObserverLive } from '../src/platform/role-permissions.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import { goldenConfigurationDocument } from './fixtures/checks-runtime-run.js';
import { scriptedRoleHostLauncher } from './fixtures/role-host/role-host-launcher.js';

import type { RecoveryFacts } from '../src/application/recovery/index.js';
import type { RoleHostLauncher } from '../src/application/role-conversations/index.js';
import type { RoleHostControl, RoleHostSessionState } from '../src/domain/role-host.js';
import type { RunEventDraft, RunHistoryDerivedState } from '../src/domain/run-history.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const RESULT_COMMIT = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

const TASK_BRANCH = 'foundry/RUN-RECOVERY';

const WORKSPACE = '/target/.agent/worktrees/RUN-RECOVERY';

const SETTLED_OBSERVATION = {
  status: 'settled' as const,
  sequence: 1,
  eventCount: 1,
  narrative: 'The role settled.',
};

function control(outcome: string): RoleHostControl {
  return { schemaVersion: 1, outcome };
}

function roleSession(
  overrides: Partial<RoleHostSessionState> & Pick<RoleHostSessionState, 'role'>,
): RoleHostSessionState {
  return {
    attempt: 1,
    generation: 1,
    sessionId: `session-${overrides.role}-1`,
    ownershipToken: 'owner-1',
    initialSequence: 0,
    runtimeIdentity: {
      adapterVersion: 'test',
      provider: 'test',
      model: 'test',
      toolProfile: 'test',
    },
    workingDirectory: null,
    submission: null,
    submissionStarted: null,
    lastObservation: null,
    stopDisposition: null,
    ...overrides,
  };
}

function derivedState(overrides: Partial<RunHistoryDerivedState> = {}): RunHistoryDerivedState {
  return {
    state: 'blocked',
    checkpoint: 'reviewing',
    attempts: [],
    cleanupProgress: null,
    sourceFrozen: null,
    guidanceFrozen: null,
    worktreeReady: {
      taskBranch: TASK_BRANCH,
      workspace: WORKSPACE,
      headCommit: FROZEN_COMMIT,
      baseCommit: FROZEN_COMMIT,
    },
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
    evidenceInvalidations: [],
    evidenceBindings: [],
    decisionApplieds: [],
    evidenceManifests: [],
    recoveryDispositions: [],
    ...overrides,
  };
}

function facts(overrides: Partial<RecoveryFacts> = {}): RecoveryFacts {
  return {
    journalIntact: true,
    lease: 'none',
    worktree: {
      registered: true,
      checkedOutBranch: TASK_BRANCH,
      headCommit: FROZEN_COMMIT,
    },
    implementation: {
      workspaceExists: true,
      currentBranch: TASK_BRANCH,
      headCommit: FROZEN_COMMIT,
      clean: true,
      baseIsAncestor: true,
      changedFiles: [],
    },
    observationProblem: null,
    failureReason: null,
    ...overrides,
  };
}

function settledReviewer(outcome: string): RoleHostSessionState {
  return roleSession({
    role: 'reviewer',
    lastObservation: {
      ...SETTLED_OBSERVATION,
      narrative: 'Reviewer settled.',
      control: control(outcome),
    },
  });
}

describe('recovery disposition classifier', () => {
  it('accepts a run that already reached a terminal success', () => {
    const classification = classifyRecovery(
      derivedState({ state: 'completed_no_change', checkpoint: null }),
      facts(),
    );
    expect(classification.disposition).toBe('accept');
  });

  it('accepts a settled attempt that is reconciled without resending the prompt', () => {
    const classification = classifyRecovery(
      derivedState({ roleSessions: [settledReviewer('approved')] }),
      facts(),
    );
    expect(classification.disposition).toBe('accept');
    expect(classification.reason).toContain('without resending the prompt');
  });

  it('accepts a durable accepted implementation without repeating the Coder turn', () => {
    const classification = classifyRecovery(
      derivedState({
        checkpoint: 'coding',
        implementation: {
          taskBranch: TASK_BRANCH,
          baseCommit: FROZEN_COMMIT,
          commit: RESULT_COMMIT,
          changedFiles: ['src/a.ts'],
          noChangeCandidate: false,
        },
      }),
      facts(),
    );
    expect(classification.disposition).toBe('accept');
  });

  it('blocks a settled role attempt that reported a blocked outcome', () => {
    const classification = classifyRecovery(
      derivedState({ roleSessions: [settledReviewer('blocked')] }),
      facts(),
    );
    expect(classification.disposition).toBe('blocked');
  });

  it('treats interrupted Coder files as evidence rather than an accepted implementation', () => {
    const coder = roleSession({
      role: 'coder',
      lastObservation: {
        ...SETTLED_OBSERVATION,
        narrative: 'Coder settled without a clean commit.',
        control: control('implemented'),
      },
    });
    const classification = classifyRecovery(
      derivedState({ checkpoint: 'coding', roleSessions: [coder] }),
      facts({
        implementation: {
          workspaceExists: true,
          currentBranch: TASK_BRANCH,
          headCommit: null,
          clean: false,
          baseIsAncestor: true,
          changedFiles: ['src/a.ts'],
        },
      }),
    );
    expect(classification.disposition).toBe('retry');
    expect(classification.reason).toContain('clean-branch rule');
  });

  it('keeps waiting on an owned submission that is still in progress', () => {
    const coder = roleSession({
      role: 'coder',
      submission: { idempotencyKey: 'key-1', promptHash: 'a'.repeat(64), baselineSequence: 0 },
      submissionStarted: 'accepted',
    });
    const classification = classifyRecovery(
      derivedState({ checkpoint: 'coding', roleSessions: [coder] }),
      facts(),
    );
    expect(classification.disposition).toBe('continue_waiting');
    expect(classification.reason).toContain('without resubmitting');
  });

  it('retries when no session was created for the recorded checkpoint', () => {
    const classification = classifyRecovery(
      derivedState({ checkpoint: 'coding', roleSessions: [] }),
      facts(),
    );
    expect(classification.disposition).toBe('retry');
    expect(classification.reason).toContain('no submission side effect');
  });

  it('retries a deterministic stage that owns no role submission', () => {
    const classification = classifyRecovery(
      derivedState({ checkpoint: 'verifying', roleSessions: [] }),
      facts(),
    );
    expect(classification.disposition).toBe('retry');
    expect(classification.reason).toContain('no role submission side effect');
  });

  it('retries a session created without a submission side effect', () => {
    const architect = roleSession({ role: 'architect' });
    const classification = classifyRecovery(
      derivedState({ checkpoint: 'planning', roleSessions: [architect] }),
      facts(),
    );
    expect(classification.disposition).toBe('retry');
  });

  it('blocks a blocked run with no recorded checkpoint', () => {
    const classification = classifyRecovery(derivedState({ checkpoint: null }), facts());
    expect(classification.disposition).toBe('blocked');
  });

  it('blocks while a live process holds repository ownership', () => {
    const classification = classifyRecovery(
      derivedState({ roleSessions: [settledReviewer('approved')] }),
      facts({ lease: 'live' }),
    );
    expect(classification.disposition).toBe('blocked');
  });

  it('stops for a person when the journal cannot be verified', () => {
    const classification = classifyRecovery(derivedState(), facts({ journalIntact: false }));
    expect(classification.disposition).toBe('human_recovery');
  });

  it('stops for a person when the recorded worktree cannot be observed', () => {
    const classification = classifyRecovery(derivedState(), facts({ worktree: null }));
    expect(classification.disposition).toBe('human_recovery');
  });

  it('stops for a person when the worktree identity drifted', () => {
    const classification = classifyRecovery(
      derivedState(),
      facts({
        worktree: { registered: true, checkedOutBranch: 'other', headCommit: FROZEN_COMMIT },
      }),
    );
    expect(classification.disposition).toBe('human_recovery');
  });

  it('stops for a person when Git observation itself failed', () => {
    const classification = classifyRecovery(
      derivedState(),
      facts({ observationProblem: 'Git could not read the worktree' }),
    );
    expect(classification.disposition).toBe('human_recovery');
  });

  it('stops for a person when repository ownership is indeterminate', () => {
    const classification = classifyRecovery(derivedState(), facts({ lease: 'indeterminate' }));
    expect(classification.disposition).toBe('human_recovery');
  });

  it('stops for a person on an ambiguous submission intent', () => {
    const coder = roleSession({
      role: 'coder',
      submission: { idempotencyKey: 'key-1', promptHash: 'a'.repeat(64), baselineSequence: 0 },
    });
    const classification = classifyRecovery(
      derivedState({ checkpoint: 'coding', roleSessions: [coder] }),
      facts(),
    );
    expect(classification.disposition).toBe('human_recovery');
  });

  it('stops for a person on a lost owned session', () => {
    const coder = roleSession({
      role: 'coder',
      lastObservation: {
        status: 'lost',
        sequence: 2,
        eventCount: 2,
        narrative: null,
        control: null,
      },
    });
    const classification = classifyRecovery(
      derivedState({ checkpoint: 'coding', roleSessions: [coder] }),
      facts(),
    );
    expect(classification.disposition).toBe('human_recovery');
  });

  it('maps a stage failure reason to retry or an integrity stop', () => {
    expect(classifyRoleFailure(null).disposition).toBe('blocked');
    const retryable = new Set(['session-missing', 'turn-timeout', 'empty-narrative']);
    for (const reason of ROLE_CONVERSATION_FAILURE_REASONS) {
      const disposition = classifyRoleFailure(reason).disposition;
      if (retryable.has(reason)) {
        expect(disposition).toBe('retry');
      } else {
        expect(disposition).toBe('human_recovery');
      }
    }
  });

  it('maps a role failure carried on the facts before the blocked-state checks', () => {
    const classification = classifyRecovery(
      derivedState({ state: 'reviewing', checkpoint: null }),
      facts({ failureReason: 'ambiguous-submission' }),
    );
    expect(classification.disposition).toBe('human_recovery');
  });
});

const RUN_ID = 'RUN-RECOVERY-EVENT';

interface EventFixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupEventFixture(): EventFixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-recovery-dispositions-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function appendEvent(runDirectory: string, createIfMissing: boolean, draft: RunEventDraft) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing,
    build: () => Effect.succeed(draft),
  }).pipe(Effect.provide(RunHistoryLive));
}

function seedPlanning(runDirectory: string) {
  return Effect.gen(function* () {
    yield* appendEvent(runDirectory, true, {
      type: 'run-created',
      payload: { taskId: 'TASK-1' },
    });
    yield* appendEvent(runDirectory, false, {
      type: 'source-frozen',
      payload: {
        repository: {
          repositoryRoot: '/repo',
          gitDirectory: '/repo/.git',
          remoteUrl: 'https://example.invalid/repo.git',
        },
        sourceRemote: 'origin',
        sourceBranch: 'main',
        sourceCommit: FROZEN_COMMIT,
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        expectedHead: FROZEN_COMMIT,
      },
    });
    yield* appendEvent(runDirectory, false, {
      type: 'guidance-frozen',
      payload: {
        sourceCommit: FROZEN_COMMIT,
        manifestPath: 'guidance-manifest.json',
        aggregateHash: 'f'.repeat(64),
        files: [],
      },
    });
    yield* appendEvent(runDirectory, false, {
      type: 'worktree-ready',
      payload: {
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        headCommit: FROZEN_COMMIT,
        baseCommit: FROZEN_COMMIT,
      },
    });
    yield* appendEvent(runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
    });
  });
}

describe('recovery-recorded event', () => {
  it.effect('derives a recovery disposition from a nonterminal run', () =>
    Effect.gen(function* () {
      const fixture = setupEventFixture();
      try {
        yield* seedPlanning(fixture.runDirectory);
        yield* appendEvent(fixture.runDirectory, false, {
          type: 'recovery-recorded',
          payload: { disposition: 'accept', reason: 'A settled attempt was reconciled.' },
        });
        const history = yield* readVerifiedRunHistory({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(RunHistoryLive));
        expect(history.derived.state).toBe('planning');
        expect(history.derived.recoveryDispositions).toHaveLength(1);
        expect(history.derived.recoveryDispositions[0]).toEqual({
          disposition: 'accept',
          reason: 'A settled attempt was reconciled.',
        });
      } finally {
        fixture.cleanup();
      }
    }).pipe(Effect.provide(RunHistoryLive)),
  );

  it.effect('rejects a recovery disposition recorded for a terminal run', () =>
    Effect.gen(function* () {
      const fixture = setupEventFixture();
      try {
        yield* seedPlanning(fixture.runDirectory);
        yield* appendEvent(fixture.runDirectory, false, {
          type: 'workflow-transition',
          payload: { route: 'fail-run', from: 'planning', to: 'failed', checkpoint: null },
        });
        yield* appendEvent(fixture.runDirectory, false, {
          type: 'recovery-recorded',
          payload: { disposition: 'blocked', reason: 'This must not be accepted.' },
        });
        const failure = yield* readVerifiedRunHistory({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(RunHistoryLive), Effect.flip);
        expect(failure).toBeInstanceOf(RunHistoryIntegrityError);
        if (!(failure instanceof RunHistoryIntegrityError)) {
          throw new Error(`Expected an integrity error but received: ${String(failure)}`);
        }
        expect(failure.problem).toContain('recovery disposition');
      } finally {
        fixture.cleanup();
      }
    }).pipe(Effect.provide(RunHistoryLive)),
  );
});

interface RunFixture {
  readonly base: string;
  readonly target: string;
  readonly remote: string;
  readonly configPath: string;
  readonly requestPath: string;
  readonly cleanup: () => void;
}

function gitExec(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

function setupRunFixture(): RunFixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-recovery-resume-'));
  const target = join(base, 'target');
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', target], { encoding: 'utf8' });
  gitExec(target, ['config', 'user.email', 'recovery@example.com']);
  gitExec(target, ['config', 'user.name', 'Foundry Recovery']);
  writeFileSync(join(target, '.gitignore'), '.agent\n');
  writeFileSync(join(target, 'README.md'), '# target\n');
  gitExec(target, ['add', '.gitignore', 'README.md']);
  gitExec(target, ['commit', '-m', 'initial']);
  gitExec(target, ['remote', 'add', 'origin', remote]);
  gitExec(target, ['push', '-u', 'origin', 'main']);
  const configPath = join(base, 'foundry.config.json');
  writeFileSync(configPath, JSON.stringify(goldenConfigurationDocument(target, false)));
  const requestPath = join(base, 'request.md');
  writeFileSync(requestPath, '# Outcome\n\nMake the app observable.\n');
  return {
    base,
    target,
    remote,
    configPath,
    requestPath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const capabilityLayers = Layer.mergeAll(
  Layer.succeed(
    ReadinessHost,
    ReadinessHost.of({
      platform: Effect.succeed('linux'),
      nodeVersion: Effect.succeed('v24.0.0'),
      npmVersion: Effect.succeed('11.0.0'),
      gitVersionOutput: Effect.succeed('git version 2.45.0'),
    }),
  ),
  ReadinessFilesLive,
  ReadinessGitLive,
  Layer.succeed(
    ProjectCommandProcess,
    ProjectCommandProcess.of({
      run: (_options: { readonly command: ReadonlyArray<string>; readonly cwd: string }) =>
        Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
    }),
  ),
  ProjectCommandsPlatformLive,
  RunIdentityLive,
  RunHistoryLive,
  RepositoryLeaseLive,
  RoleTurnResourceObserverLive,
  RunGitLive,
  GuidanceLive,
);

function withRoleHost(roleHost: Layer.Layer<RoleHostLauncher>) {
  return Layer.mergeAll(capabilityLayers, roleHost);
}

function runBlockedReviewer(fixture: RunFixture, runId: string) {
  const roleHost = scriptedRoleHostLauncher({
    architect: {
      narrative: 'The plan is ready.',
      control: {
        schemaVersion: 1,
        outcome: 'plan_ready',
        acceptanceCriteria: ['the change works'],
        runtimeValidation: 'not_required',
        execution: 'sequential',
      },
    },
    coder: {
      narrative: 'No change is required.',
      control: { schemaVersion: 1, outcome: 'no_change_candidate' },
    },
    reviewer: {
      narrative: 'Reviewer cannot safely review.',
      control: { schemaVersion: 1, outcome: 'blocked' },
    },
  });
  return runCli([
    'run',
    '--config',
    fixture.configPath,
    '--request',
    fixture.requestPath,
    '--task-id',
    'TASK-RECOVERY',
    '--run-id',
    runId,
    '--json',
  ]).pipe(Effect.provide(withRoleHost(roleHost)));
}

function readHistory(fixture: RunFixture, runId: string) {
  return readVerifiedRunHistory({
    runDirectory: join(fixture.target, '.agent', 'runs', runId),
    runId,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

function runInvalidReviewerControl(fixture: RunFixture, runId: string) {
  const roleHost = scriptedRoleHostLauncher({
    architect: {
      narrative: 'The plan is ready.',
      control: {
        schemaVersion: 1,
        outcome: 'plan_ready',
        acceptanceCriteria: ['the change works'],
        runtimeValidation: 'not_required',
        execution: 'sequential',
      },
    },
    coder: {
      narrative: 'No change is required.',
      control: { schemaVersion: 1, outcome: 'no_change_candidate' },
    },
    reviewer: {
      narrative: 'The reviewer control cannot be decoded.',
      control: { schemaVersion: 1, outcome: 'bogus' },
    },
  });
  return runCli([
    'run',
    '--config',
    fixture.configPath,
    '--request',
    fixture.requestPath,
    '--task-id',
    'TASK-RECOVERY',
    '--run-id',
    runId,
    '--json',
  ]).pipe(Effect.provide(withRoleHost(roleHost)));
}

describe('resume recovery', () => {
  it.live('does not repeat a settled role prompt and records the recovery disposition', () =>
    Effect.gen(function* () {
      const fixture = setupRunFixture();
      try {
        const first = yield* runBlockedReviewer(fixture, 'RUN-RECOVERY-BLOCKED');
        expect(first.exitCode).toBe(1);
        const before = yield* readHistory(fixture, 'RUN-RECOVERY-BLOCKED');
        expect(before.derived.state).toBe('blocked');
        const sessionsBefore = before.derived.roleSessions.length;

        const resumed = yield* runCli([
          'resume',
          '--config',
          fixture.configPath,
          '--run-id',
          'RUN-RECOVERY-BLOCKED',
          '--json',
        ]).pipe(Effect.provide(withRoleHost(scriptedRoleHostLauncher({}))));
        expect(resumed.exitCode).toBe(1);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(resumed.stdout);
        expect(envelope.ok).toBe(false);
        if (envelope.ok) {
          throw new Error(`Expected a blocked failure envelope: ${resumed.stdout}`);
        }
        expect(envelope.error.kind).toBe('blocked');

        const after = yield* readHistory(fixture, 'RUN-RECOVERY-BLOCKED');
        expect(after.derived.state).toBe('blocked');
        expect(after.derived.roleSessions.length).toBe(sessionsBefore);
        expect(after.events.filter((event) => event.type === 'run-created')).toHaveLength(1);
        const dispositions = after.derived.recoveryDispositions;
        expect(dispositions.length).toBeGreaterThanOrEqual(1);
        expect(dispositions[dispositions.length - 1]?.disposition).toBe('blocked');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live(
    'reattaches a settled attempt on an accepted resume instead of allocating a new one',
    () =>
      Effect.gen(function* () {
        const fixture = setupRunFixture();
        try {
          const first = yield* runInvalidReviewerControl(fixture, 'RUN-RECOVERY-ACCEPT');
          expect(first.exitCode).toBe(1);
          const before = yield* readHistory(fixture, 'RUN-RECOVERY-ACCEPT');
          expect(before.derived.state).toBe('blocked');
          const sessionsBefore = before.derived.roleSessions.length;
          expect(sessionsBefore).toBeGreaterThanOrEqual(1);

          const resumed = yield* runCli([
            'resume',
            '--config',
            fixture.configPath,
            '--run-id',
            'RUN-RECOVERY-ACCEPT',
            '--json',
          ]).pipe(Effect.provide(withRoleHost(scriptedRoleHostLauncher({}))));
          expect(resumed.exitCode).toBe(1);

          const after = yield* readHistory(fixture, 'RUN-RECOVERY-ACCEPT');
          expect(after.derived.roleSessions.length).toBe(sessionsBefore);
          const dispositions = after.derived.recoveryDispositions;
          expect(dispositions.some((entry) => entry.disposition === 'accept')).toBe(true);
        } finally {
          fixture.cleanup();
        }
      }),
  );
});
