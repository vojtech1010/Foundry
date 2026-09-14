import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { buildRunStatus, readRunStatus } from '../src/application/status/index.js';
import {
  RUN_HISTORY_FILENAME,
  RUN_HISTORY_WITNESS_FILENAME,
  encodeRunEventLine,
  encodeRunHistoryWitness,
  sealRunEvent,
  verifyRunHistoryEvents,
} from '../src/domain/run-history.js';
import { EXIT_CODES } from '../src/domain/public-commands.js';
import { ReadinessFilesLive } from '../src/platform/readiness.js';
import { RunHistoryLive } from '../src/platform/run-history.js';

import type { RunEvent, RunEventDraft, RunEventEnvelope } from '../src/domain/run-history.js';

const RUN_ID = 'RUN-STATUS';

const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const IMPLEMENTED_COMMIT = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

const TASK_BRANCH = 'foundry/RUN-STATUS';

const WORKSPACE = '/target/.agent/worktrees/RUN-STATUS';

const OCCURRED_AT = '2026-09-13T00:00:00.000Z';

const OCCURRED_AT_MILLIS = 1789257600000;

const RUNTIME_IDENTITY = {
  adapterVersion: 'test',
  provider: 'test',
  model: 'test',
  toolProfile: 'test',
};

const REJECTED_NARRATIVE = '# Result\n\nThe original rejected narrative.';

const REJECTED_CONTROL = { schemaVersion: 1, outcome: 'bogus' };

const REPAIRED_CONTROL = { schemaVersion: 1, outcome: 'implemented' };

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function eventId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function sealChain(runId: string, drafts: ReadonlyArray<RunEventDraft>): ReadonlyArray<RunEvent> {
  const events: Array<RunEvent> = [];
  let previousHash: string | null = null;
  drafts.forEach((draft, index) => {
    const envelope: RunEventEnvelope = {
      schemaVersion: 1,
      runId,
      revision: index + 1,
      eventId: eventId(index + 1),
      occurredAt: OCCURRED_AT,
      previousEventHash: previousHash,
    };
    const sealed = sealRunEvent(envelope, draft);
    events.push(sealed);
    previousHash = sealed.eventHash;
  });
  return events;
}

const PROVISIONING: ReadonlyArray<RunEventDraft> = [
  { type: 'run-created', payload: { taskId: 'TASK-STATUS' } },
  {
    type: 'source-frozen',
    payload: {
      repository: {
        repositoryRoot: '/target',
        gitDirectory: '/target/.git',
        remoteUrl: 'https://example.invalid/target.git',
      },
      sourceRemote: 'origin',
      sourceBranch: 'main',
      sourceCommit: FROZEN_COMMIT,
      taskBranch: TASK_BRANCH,
      workspace: WORKSPACE,
      expectedHead: FROZEN_COMMIT,
    },
  },
  {
    type: 'guidance-frozen',
    payload: {
      sourceCommit: FROZEN_COMMIT,
      manifestPath: 'guidance-manifest.json',
      aggregateHash: 'f'.repeat(64),
      files: [],
    },
  },
  {
    type: 'worktree-ready',
    payload: {
      taskBranch: TASK_BRANCH,
      workspace: WORKSPACE,
      headCommit: FROZEN_COMMIT,
      baseCommit: FROZEN_COMMIT,
    },
  },
  {
    type: 'workflow-transition',
    payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
  },
  {
    type: 'plan-accepted',
    payload: {
      outcome: 'plan_ready',
      criteria: [{ id: 'AC-001', text: 'the seeded criterion' }],
      runtimeValidationRequired: false,
      execution: {
        mode: 'sequential',
        objectives: [
          {
            id: 'OBJ-001',
            title: 'Implement the accepted plan',
            affectedPaths: ['.'],
            criterionIds: ['AC-001'],
          },
        ],
      },
    },
  },
  {
    type: 'workflow-transition',
    payload: { route: 'plan-accepted', from: 'planning', to: 'coding', checkpoint: null },
  },
];

/**
 * A coder session that rejects its first control envelope, repairs it inside the
 * same session, and settles. The same-session repair is not a Foundry role retry.
 */
const SESSION_AND_REPAIR: ReadonlyArray<RunEventDraft> = [
  {
    type: 'role-session-created',
    payload: {
      role: 'coder',
      attempt: 1,
      generation: 1,
      sessionId: 'session-1',
      ownershipToken: 'owner-1',
      sequence: 0,
      runtimeIdentity: RUNTIME_IDENTITY,
      workingDirectory: null,
    },
  },
  {
    type: 'role-session-submission-requested',
    payload: {
      sessionId: 'session-1',
      generation: 1,
      idempotencyKey: 'key-1',
      promptHash: 'a'.repeat(64),
      baselineSequence: 0,
    },
  },
  {
    type: 'role-session-submission-started',
    payload: {
      sessionId: 'session-1',
      generation: 1,
      idempotencyKey: 'key-1',
      submission: 'accepted',
    },
  },
  {
    type: 'role-session-observed',
    payload: {
      sessionId: 'session-1',
      generation: 1,
      status: 'settled',
      sequence: 1,
      eventCount: 1,
      narrative: REJECTED_NARRATIVE,
      control: REJECTED_CONTROL,
    },
  },
  {
    type: 'role-control-rejected',
    payload: {
      sessionId: 'session-1',
      generation: 1,
      sequence: 1,
      narrativeHash: sha256(REJECTED_NARRATIVE),
      controlHash: sha256(JSON.stringify(REJECTED_CONTROL)),
      problem: 'the control envelope is invalid',
    },
  },
  {
    type: 'role-control-repair-requested',
    payload: {
      sessionId: 'session-1',
      generation: 1,
      idempotencyKey: 'key-2',
      promptHash: 'd'.repeat(64),
      baselineSequence: 1,
      problem: 'the control envelope is invalid',
    },
  },
  {
    type: 'role-control-repair-started',
    payload: {
      sessionId: 'session-1',
      generation: 1,
      idempotencyKey: 'key-2',
      submission: 'accepted',
    },
  },
  {
    type: 'role-session-observed',
    payload: {
      sessionId: 'session-1',
      generation: 1,
      status: 'settled',
      sequence: 2,
      eventCount: 2,
      narrative: REJECTED_NARRATIVE,
      control: REPAIRED_CONTROL,
    },
  },
];

const OUTCOME: ReadonlyArray<RunEventDraft> = [
  {
    type: 'workflow-attempt',
    payload: {
      sequence: 1,
      kind: 'retry',
      role: 'coder',
      state: 'coding',
      reason: 'One Foundry coder role retry was spent.',
    },
  },
  {
    type: 'implementation-accepted',
    payload: {
      taskBranch: TASK_BRANCH,
      baseCommit: FROZEN_COMMIT,
      commit: IMPLEMENTED_COMMIT,
      changedFiles: ['src/a.ts'],
      noChangeCandidate: false,
    },
  },
  {
    type: 'finding-recorded',
    payload: {
      id: 'FND-001',
      category: 'check',
      source: 'failed-check',
      owner: 'coder',
      severity: 'high',
      blocking: false,
      commit: IMPLEMENTED_COMMIT,
      description: 'A non-blocking finding recorded for the accepted commit.',
      detail: 'The finding is retained for Reviewer context.',
      evidence: ['log /evidence/lint.log sha256:' + 'b'.repeat(64)],
    },
  },
  {
    type: 'workflow-transition',
    payload: { route: 'implementation-ready', from: 'coding', to: 'verifying', checkpoint: null },
  },
  {
    type: 'workflow-transition',
    payload: {
      route: 'correction-required',
      from: 'verifying',
      to: 'correcting',
      checkpoint: null,
    },
  },
  {
    type: 'role-session-created',
    payload: {
      role: 'coder',
      attempt: 2,
      generation: 2,
      sessionId: 'session-2',
      ownershipToken: 'owner-2',
      sequence: 0,
      runtimeIdentity: RUNTIME_IDENTITY,
      workingDirectory: null,
    },
  },
];

const ALL_DRAFTS: ReadonlyArray<RunEventDraft> = [
  ...PROVISIONING,
  ...SESSION_AND_REPAIR,
  ...OUTCOME,
];

function verifiedHistory() {
  const events = sealChain(RUN_ID, ALL_DRAFTS);
  const verification = verifyRunHistoryEvents(events, RUN_ID);
  if (!verification.ok) {
    throw new Error(`Expected valid seeded history but received: ${verification.problem}`);
  }
  return {
    history: {
      runId: RUN_ID,
      events,
      head: verification.head,
      derived: verification.derived,
      streamBytes: null,
      witnessBytes: null,
    },
    runDirectory: join('/target', '.agent', 'runs', RUN_ID),
  };
}

describe('bounded status derivation', () => {
  it('derives active role, elapsed time, last event, counts, and unknown usage', () => {
    const { history, runDirectory } = verifiedHistory();
    const nowMillis = OCCURRED_AT_MILLIS + 120_000;
    const report = buildRunStatus({ runDirectory, history, nowMillis });

    expect(report.runId).toBe(RUN_ID);
    expect(report.workflowState).toBe('correcting');
    expect(report.activeRole).toEqual({ role: 'coder', attempt: 2 });
    expect(report.startedAt).toBe(OCCURRED_AT);
    expect(report.elapsedMs).toBe(120_000);
    expect(report.branch).toBe(TASK_BRANCH);
    expect(report.commit).toBe(IMPLEMENTED_COMMIT);
    expect(report.historyPath).toBe(join(runDirectory, RUN_HISTORY_FILENAME));
    expect(report.revision).toBe(ALL_DRAFTS.length);
    expect(report.lastEvent).toMatchObject({
      revision: ALL_DRAFTS.length,
      type: 'role-session-created',
    });
    expect(report.lastEvent?.detail).toContain('attempt 2');

    expect(report.counts).toEqual({
      roleAttempts: 2,
      retries: 1,
      repairs: 0,
      controlRepairs: 1,
      corrections: 1,
      findings: 1,
    });
    expect(report.provenance).toMatchObject({
      sourceRemote: 'origin',
      sourceBranch: 'main',
      taskBranch: TASK_BRANCH,
      workspace: WORKSPACE,
      sourceCommit: FROZEN_COMMIT,
      headCommit: FROZEN_COMMIT,
    });

    expect(report.usage.tokens.available).toBe(false);
    expect(report.usage.tokens.total).toBeNull();
    expect(report.usage.tokens.detail).not.toBe('');
    expect(report.usage.cost.available).toBe(false);
    expect(report.usage.cost.total).toBeNull();
  });

  it('counts a same-session control repair separately from a role retry', () => {
    const { history, runDirectory } = verifiedHistory();
    const report = buildRunStatus({ runDirectory, history, nowMillis: OCCURRED_AT_MILLIS });

    expect(history.derived.roleControlRepairs).toHaveLength(1);
    expect(history.derived.roleSessions).toHaveLength(2);
    expect(report.counts.retries).toBe(1);
    expect(report.counts.controlRepairs).toBe(1);
    expect(report.counts.retries).not.toBe(
      report.counts.controlRepairs + history.derived.roleSessions.length,
    );
  });

  it('reports no active role for a state without role work', () => {
    const { history, runDirectory } = verifiedHistory();
    const verifying = buildRunStatus({
      runDirectory,
      history: {
        ...history,
        derived: { ...history.derived, state: 'verifying' },
      },
      nowMillis: OCCURRED_AT_MILLIS,
    });
    expect(verifying.activeRole).toBeNull();
  });
});

function goldenConfiguration(targetRepository: string) {
  return {
    schemaVersion: 1,
    targetRepository,
    sourceRemote: 'origin',
    sourceBranch: 'main',
    taskBranchPolicy: 'foundry/<task-id>',
    roleHarness: {
      protocol: 'foundry-role-host-v1',
      command: ['foundry-role-host'],
      environmentAllowlist: [],
    },
    roles: {
      architect: { harness: 'codex', model: 'gpt-5-codex' },
      coder: { harness: 'codex', model: 'gpt-5-codex' },
      lead_coder: { harness: 'opencode', model: 'openai/gpt-5' },
      tester: { harness: 'opencode', model: 'openai/gpt-5' },
      reviewer: { harness: 'codex', model: 'gpt-5-codex' },
    },
    timeouts: {
      roleMs: 1800000,
      settleMs: 30000,
      pollMs: 100,
      commandMs: 900000,
      runtimeReadinessMs: 120000,
      cleanupMs: 30000,
      leaseMs: 60000,
    },
    retryBudgets: { architect: 1, coder: 2, tester: 1, reviewer: 1 },
    operationalRetryBudgets: { git: 2, runtime: 1, publication: 2, cleanup: 1 },
    limits: { maxParallelCoders: 4, maxCorrectionRounds: 2, maxControlRepairsPerAttempt: 1 },
    projectProfile: {
      guidancePaths: [],
      commands: {
        bootstrap: null,
        formatCheck: ['npm', 'run', 'format:check'],
        lint: ['npm', 'run', 'lint'],
        typecheck: ['npm', 'run', 'typecheck'],
        test: ['npm', 'test'],
        build: ['npm', 'run', 'build'],
      },
    },
    runtimeProfile: null,
    decisionPublication: null,
    artifacts: {
      retentionDays: 30,
      maxRequestBytes: 262144,
      maxGuidanceBytes: 1048576,
      maxRoleHandoffBytes: 262144,
      maxEvidenceBytes: 26214400,
      maxTerminalCaptureBytes: 10485760,
      maxRunBytes: 104857600,
      redactionPatterns: [],
    },
  };
}

interface Fixture {
  readonly base: string;
  readonly target: string;
  readonly configPath: string;
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-status-'));
  const target = join(base, 'target');
  const runDirectory = join(target, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  const configPath = join(base, 'foundry.config.json');
  writeFileSync(configPath, JSON.stringify(goldenConfiguration(target)));
  const events = sealChain(RUN_ID, ALL_DRAFTS);
  const stream = Buffer.concat(events.map((event) => Buffer.from(encodeRunEventLine(event))));
  writeFileSync(join(runDirectory, RUN_HISTORY_FILENAME), stream);
  const last = events[events.length - 1];
  writeFileSync(
    join(runDirectory, RUN_HISTORY_WITNESS_FILENAME),
    Buffer.from(
      encodeRunHistoryWitness({
        schemaVersion: 1,
        runId: RUN_ID,
        revision: events.length,
        eventHash: last?.eventHash ?? '',
      }),
    ),
  );
  return {
    base,
    target,
    configPath,
    runDirectory,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const StatusCliLayer = Layer.mergeAll(ReadinessFilesLive, RunHistoryLive);

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

function statusEnvelope(stdout: string) {
  const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(stdout);
  expect(envelope.ok).toBe(true);
  if (!envelope.ok) {
    throw new Error(`Expected a success envelope but received: ${stdout}`);
  }
  return envelope.data;
}

describe('status through the cli envelope', () => {
  it.effect('presents the same bounded facts in json and human output', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const before = readFileSync(join(fixture.runDirectory, RUN_HISTORY_FILENAME), 'utf8');
        const jsonResult = yield* runCli([
          'status',
          '--config',
          fixture.configPath,
          '--run-id',
          RUN_ID,
          '--json',
        ]).pipe(Effect.provide(StatusCliLayer));
        expect(jsonResult.exitCode).toBe(EXIT_CODES.reported);
        const data = statusEnvelope(jsonResult.stdout);
        if (!('usage' in data)) {
          throw new Error('Expected a status report shape.');
        }
        expect(data.runId).toBe(RUN_ID);
        expect(data.workflowState).toBe('correcting');
        expect(data.activeRole).toEqual({ role: 'coder', attempt: 2 });
        expect(data.branch).toBe(TASK_BRANCH);
        expect(data.commit).toBe(IMPLEMENTED_COMMIT);
        expect(data.counts).toEqual({
          roleAttempts: 2,
          retries: 1,
          repairs: 0,
          controlRepairs: 1,
          corrections: 1,
          findings: 1,
        });
        expect(data.usage.tokens).toMatchObject({ available: false, total: null });
        expect(data.usage.cost).toMatchObject({ available: false, total: null });
        expect(data.lastEvent).not.toBeNull();

        const humanResult = yield* runCli([
          'status',
          '--config',
          fixture.configPath,
          '--run-id',
          RUN_ID,
        ]).pipe(Effect.provide(StatusCliLayer));
        expect(humanResult.exitCode).toBe(EXIT_CODES.reported);
        expect(humanResult.stdout).toContain('command: status');
        expect(humanResult.stdout).toContain(`data.runId: ${RUN_ID}`);
        expect(humanResult.stdout).toContain('data.workflowState: correcting');
        expect(humanResult.stdout).toContain('data.activeRole: coder attempt 2');
        expect(humanResult.stdout).toContain(`data.branch: ${TASK_BRANCH}`);
        expect(humanResult.stdout).toContain(`data.commit: ${IMPLEMENTED_COMMIT}`);
        expect(humanResult.stdout).toContain('data.counts.retries: 1');
        expect(humanResult.stdout).toContain('data.counts.controlRepairs: 1');
        expect(humanResult.stdout).toContain('data.usage.tokens.available: false');
        expect(humanResult.stdout).toContain('data.usage.tokens.total: unknown');
        expect(humanResult.stdout).toContain('data.usage.cost.total: unknown');
        expect(humanResult.stdout).toContain(`data.provenance.taskBranch: ${TASK_BRANCH}`);
        expect(humanResult.stdout.endsWith('\n')).toBe(true);

        const after = readFileSync(join(fixture.runDirectory, RUN_HISTORY_FILENAME), 'utf8');
        expect(after).toBe(before);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('fails with a typed integrity report instead of repairing history', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        rmSync(join(fixture.runDirectory, RUN_HISTORY_FILENAME));
        const result = yield* runCli([
          'status',
          '--config',
          fixture.configPath,
          '--run-id',
          RUN_ID,
          '--json',
        ]).pipe(Effect.provide(StatusCliLayer));
        expect(result.exitCode).toBe(EXIT_CODES.operationFailed);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(false);
        if (envelope.ok) {
          throw new Error('Expected a failure envelope.');
        }
        expect(envelope.error.kind).toBe('failed');
        expect(envelope.error.message).toContain('witness remains');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('readRunStatus', () => {
  it.effect('reads and reconciles a verified run without appending events', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const before = readFileSync(join(fixture.runDirectory, RUN_HISTORY_FILENAME), 'utf8');
        const report = yield* readRunStatus({
          configArg: fixture.configPath,
          cwd: '/',
          runId: RUN_ID,
        }).pipe(Effect.provide(StatusCliLayer));
        expect(report.workflowState).toBe('correcting');
        expect(report.counts.controlRepairs).toBe(1);
        expect(report.usage.tokens.available).toBe(false);
        const after = readFileSync(join(fixture.runDirectory, RUN_HISTORY_FILENAME), 'utf8');
        expect(after).toBe(before);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
