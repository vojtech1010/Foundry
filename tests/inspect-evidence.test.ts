import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRunInspectReport, readRunInspect } from '../src/application/inspect/index.js';
import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { EXIT_CODES } from '../src/domain/public-commands.js';
import {
  RUN_HISTORY_FILENAME,
  RUN_HISTORY_WITNESS_FILENAME,
  encodeRunEventLine,
  encodeRunHistoryWitness,
  sealRunEvent,
  verifyRunHistoryEvents,
} from '../src/domain/run-history.js';
import { ReadinessFilesLive } from '../src/platform/readiness.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { goldenConfigurationDocument } from './fixtures/checks-runtime-run.js';

import type { RunEvent, RunEventDraft, RunEventEnvelope } from '../src/domain/run-history.js';
import type { VerifiedRunHistory } from '../src/application/run-history/index.js';

const RUN_ID = 'RUN-INSPECT';

const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const COMMIT_ONE = '1111111111111111111111111111111111111111';

const COMMIT_TWO = '2222222222222222222222222222222222222222';

const TASK_BRANCH = 'foundry/RUN-INSPECT';

const WORKSPACE = '/target/.agent/worktrees/RUN-INSPECT';

const OCCURRED_AT = '2026-09-13T00:00:00.000Z';

const RUNTIME_IDENTITY = {
  adapterVersion: 'test',
  provider: 'test',
  model: 'test',
  toolProfile: 'test',
};

const HASH_D = 'd'.repeat(64);

const HASH_E = 'e'.repeat(64);

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
  { type: 'run-created', payload: { taskId: 'TASK-INSPECT' } },
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
            affectedPaths: ['src/implementation.ts'],
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

const CODER_SESSION: ReadonlyArray<RunEventDraft> = [
  {
    type: 'workflow-attempt',
    payload: {
      sequence: 1,
      kind: 'retry',
      role: 'coder',
      state: 'coding',
      reason: 'The first Coder attempt was retried.',
    },
  },
  {
    type: 'role-session-created',
    payload: {
      role: 'coder',
      attempt: 1,
      generation: 1,
      sessionId: 'session-coder-1',
      ownershipToken: 'owner-coder-1',
      sequence: 0,
      runtimeIdentity: RUNTIME_IDENTITY,
      workingDirectory: null,
    },
  },
  {
    type: 'role-session-submission-requested',
    payload: {
      sessionId: 'session-coder-1',
      generation: 1,
      idempotencyKey: 'key-coder-1',
      promptHash: 'a'.repeat(64),
      baselineSequence: 0,
    },
  },
  {
    type: 'role-session-submission-started',
    payload: {
      sessionId: 'session-coder-1',
      generation: 1,
      idempotencyKey: 'key-coder-1',
      submission: 'accepted',
    },
  },
  {
    type: 'role-session-observed',
    payload: {
      sessionId: 'session-coder-1',
      generation: 1,
      status: 'settled',
      sequence: 1,
      eventCount: 1,
      narrative: '# Coder result\n\nFirst attempt.',
      control: { schemaVersion: 1, outcome: 'implemented' },
    },
  },
];

const COMPLETED_DRAFTS: ReadonlyArray<RunEventDraft> = [
  ...PROVISIONING,
  ...CODER_SESSION,
  {
    type: 'implementation-accepted',
    payload: {
      taskBranch: TASK_BRANCH,
      baseCommit: FROZEN_COMMIT,
      commit: COMMIT_ONE,
      changedFiles: ['src/implementation.ts'],
      noChangeCandidate: false,
    },
  },
  {
    type: 'workflow-transition',
    payload: {
      route: 'implementation-ready',
      from: 'coding',
      to: 'verifying',
      checkpoint: null,
    },
  },
  {
    type: 'verification-completed',
    payload: {
      attempt: 1,
      repository: '/target',
      commit: COMMIT_ONE,
      profileHash: 'a'.repeat(64),
      commandMs: 10,
      executions: [
        {
          kind: 'gate',
          name: 'formatCheck',
          executable: 'fmt',
          arguments: ['--check'],
          expectedExitCode: 0,
          actualExitCode: 1,
          timedOut: false,
          durationMs: 1,
          log: {
            path: '/evidence/formatCheck.log',
            sha256: 'c'.repeat(64),
            byteLength: 12,
            retainedByteLength: 12,
            truncated: false,
            redactionCount: 0,
          },
          trackedMutation: null,
          reconstructed: false,
          reconstructionError: null,
        },
      ],
      result: 'failed',
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
      blocking: true,
      commit: COMMIT_ONE,
      description: 'Required command "formatCheck" failed; the deterministic gate failed.',
      detail: 'The deterministic project command "formatCheck" did not pass.',
      evidence: [
        `log /evidence/formatCheck.log sha256:${HASH_D} bytes:12 retained:12 truncated:false redactions:0`,
        'manual screenshot login.png',
      ],
    },
  },
  {
    type: 'finding-recorded',
    payload: {
      id: 'FND-002',
      category: 'review',
      source: 'reviewer-changes-requested',
      owner: 'coder',
      severity: 'medium',
      blocking: false,
      commit: COMMIT_ONE,
      description: 'Reviewer requested a bounded change.',
      detail: 'The Reviewer narrative is retained verbatim.',
      evidence: [`reviewer narrative sha256:${HASH_E}`],
    },
  },
  {
    type: 'finding-recorded',
    payload: {
      id: 'FND-003',
      category: 'check',
      source: 'failed-check',
      owner: 'coder',
      severity: 'low',
      blocking: false,
      commit: COMMIT_ONE,
      description: 'A duplicated log reference under a different label.',
      detail: 'The same content hash is described by two labels.',
      evidence: [`log /evidence/formatCheck-alt.log sha256:${HASH_D}`],
    },
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
      sessionId: 'session-coder-2',
      ownershipToken: 'owner-coder-2',
      sequence: 0,
      runtimeIdentity: RUNTIME_IDENTITY,
      workingDirectory: null,
    },
  },
  {
    type: 'implementation-accepted',
    payload: {
      taskBranch: TASK_BRANCH,
      baseCommit: FROZEN_COMMIT,
      commit: COMMIT_TWO,
      changedFiles: ['src/implementation.ts'],
      noChangeCandidate: false,
    },
  },
  {
    type: 'workflow-transition',
    payload: {
      route: 'implementation-ready',
      from: 'correcting',
      to: 'verifying',
      checkpoint: null,
    },
  },
  {
    type: 'verification-completed',
    payload: {
      attempt: 2,
      repository: '/target',
      commit: COMMIT_TWO,
      profileHash: 'b'.repeat(64),
      commandMs: 20,
      executions: [
        {
          kind: 'gate',
          name: 'formatCheck',
          executable: 'fmt',
          arguments: ['--check'],
          expectedExitCode: 0,
          actualExitCode: 0,
          timedOut: false,
          durationMs: 1,
          log: {
            path: '/evidence/formatCheck-2.log',
            sha256: 'f'.repeat(64),
            byteLength: 5,
            retainedByteLength: 5,
            truncated: false,
            redactionCount: 0,
          },
          trackedMutation: null,
          reconstructed: false,
          reconstructionError: null,
        },
      ],
      result: 'passed',
    },
  },
  {
    type: 'workflow-transition',
    payload: {
      route: 'checks-passed-reviewing',
      from: 'verifying',
      to: 'reviewing',
      checkpoint: null,
    },
  },
  {
    type: 'role-session-created',
    payload: {
      role: 'reviewer',
      attempt: 1,
      generation: 1,
      sessionId: 'session-reviewer-1',
      ownershipToken: 'owner-reviewer-1',
      sequence: 0,
      runtimeIdentity: RUNTIME_IDENTITY,
      workingDirectory: null,
    },
  },
  {
    type: 'role-session-submission-requested',
    payload: {
      sessionId: 'session-reviewer-1',
      generation: 1,
      idempotencyKey: 'key-reviewer-1',
      promptHash: 'c'.repeat(64),
      baselineSequence: 0,
    },
  },
  {
    type: 'role-session-submission-started',
    payload: {
      sessionId: 'session-reviewer-1',
      generation: 1,
      idempotencyKey: 'key-reviewer-1',
      submission: 'accepted',
    },
  },
  {
    type: 'role-session-observed',
    payload: {
      sessionId: 'session-reviewer-1',
      generation: 1,
      status: 'settled',
      sequence: 1,
      eventCount: 1,
      narrative: '# Review\n\nThe change is approved.',
      control: { schemaVersion: 1, outcome: 'approved' },
    },
  },
  {
    type: 'workflow-transition',
    payload: {
      route: 'review-approved',
      from: 'reviewing',
      to: 'completed',
      checkpoint: null,
    },
  },
  {
    type: 'cleanup-progress',
    payload: {
      outcome: 'succeeded',
      detail: 'Disposed the runtime, role sessions, and run worktree.',
    },
  },
];

const DECISION_NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const DECISION_QUESTION = 'Should Foundry keep the existing retry budget or raise it?';

const DECISION_DRAFTS: ReadonlyArray<RunEventDraft> = [
  ...PROVISIONING,
  {
    type: 'implementation-accepted',
    payload: {
      taskBranch: TASK_BRANCH,
      baseCommit: FROZEN_COMMIT,
      commit: COMMIT_ONE,
      changedFiles: ['src/implementation.ts'],
      noChangeCandidate: false,
    },
  },
  {
    type: 'workflow-transition',
    payload: {
      route: 'implementation-ready',
      from: 'coding',
      to: 'verifying',
      checkpoint: null,
    },
  },
  {
    type: 'verification-completed',
    payload: {
      attempt: 1,
      repository: '/target',
      commit: COMMIT_ONE,
      profileHash: 'a'.repeat(64),
      commandMs: 10,
      executions: [
        {
          kind: 'gate',
          name: 'formatCheck',
          executable: 'fmt',
          arguments: ['--check'],
          expectedExitCode: 0,
          actualExitCode: 0,
          timedOut: false,
          durationMs: 1,
          log: {
            path: '/evidence/formatCheck.log',
            sha256: 'c'.repeat(64),
            byteLength: 12,
            retainedByteLength: 12,
            truncated: false,
            redactionCount: 0,
          },
          trackedMutation: null,
          reconstructed: false,
          reconstructionError: null,
        },
      ],
      result: 'passed',
    },
  },
  {
    type: 'workflow-transition',
    payload: {
      route: 'checks-passed-reviewing',
      from: 'verifying',
      to: 'reviewing',
      checkpoint: null,
    },
  },
  {
    type: 'finding-recorded',
    payload: {
      id: 'FND-001',
      category: 'review',
      source: 'reviewer-changes-requested',
      owner: 'coder',
      severity: 'high',
      blocking: true,
      commit: COMMIT_ONE,
      description: 'A blocking risk remains unresolved.',
      detail: 'The Reviewer escalated this risk to the operator.',
      evidence: [`reviewer narrative sha256:${HASH_E}`],
    },
  },
  {
    type: 'role-session-created',
    payload: {
      role: 'reviewer',
      attempt: 1,
      generation: 1,
      sessionId: 'session-reviewer-1',
      ownershipToken: 'owner-reviewer-1',
      sequence: 0,
      runtimeIdentity: RUNTIME_IDENTITY,
      workingDirectory: null,
    },
  },
  {
    type: 'role-session-submission-requested',
    payload: {
      sessionId: 'session-reviewer-1',
      generation: 1,
      idempotencyKey: 'key-reviewer-1',
      promptHash: 'c'.repeat(64),
      baselineSequence: 0,
    },
  },
  {
    type: 'role-session-submission-started',
    payload: {
      sessionId: 'session-reviewer-1',
      generation: 1,
      idempotencyKey: 'key-reviewer-1',
      submission: 'accepted',
    },
  },
  {
    type: 'role-session-observed',
    payload: {
      sessionId: 'session-reviewer-1',
      generation: 1,
      status: 'settled',
      sequence: 1,
      eventCount: 1,
      narrative: '# Decision\n\nA person must decide the retry budget.',
      control: {
        schemaVersion: 1,
        outcome: 'human_decision_required',
        decision: {
          question: DECISION_QUESTION,
          options: [
            { label: 'Keep the retry budget', action: 'accept' },
            { label: 'Raise the retry budget', action: 'correct' },
          ],
          recommendation: 'Keep the retry budget',
        },
      },
    },
  },
  {
    type: 'workflow-transition',
    payload: {
      route: 'human-decision-required',
      from: 'reviewing',
      to: 'publishing',
      checkpoint: null,
    },
  },
  {
    type: 'workflow-transition',
    payload: {
      route: 'draft-pr-reconciled',
      from: 'publishing',
      to: 'human_decision_required',
      checkpoint: null,
    },
  },
];

const EMPTY_DRAFTS: ReadonlyArray<RunEventDraft> = PROVISIONING.slice(0, 5);

interface InspectSeededHistory {
  readonly history: VerifiedRunHistory;
  readonly runDirectory: string;
}

function verifiedHistory(drafts: ReadonlyArray<RunEventDraft>): InspectSeededHistory {
  const events = sealChain(RUN_ID, drafts);
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

function withForwardEvents(
  history: VerifiedRunHistory,
  forward: ReadonlyArray<unknown>,
): VerifiedRunHistory {
  // SAFETY: decision-publication records are intentionally outside the canonical
  // event union at this branch point. The report reader recognizes them
  // structurally, and every other field still comes from the verified history.
  return { ...history, events: [...history.events, ...forward] } as VerifiedRunHistory;
}

describe('inspect report projection', () => {
  it('links a criterion through the result commit, checks, and Reviewer assessment', () => {
    const { history, runDirectory } = verifiedHistory(COMPLETED_DRAFTS);
    const report = buildRunInspectReport({ runDirectory, history });

    expect(report.workflowState).toBe('completed');
    expect(report.plan).not.toBeNull();
    const criterion = report.plan?.criteria[0];
    expect(criterion).toMatchObject({
      id: 'AC-001',
      objectiveIds: ['OBJ-001'],
      resultCommit: COMMIT_TWO,
      reviewerOutcome: 'approved',
    });
    expect(criterion?.checks).toContain('formatCheck');

    expect(report.implementation).toMatchObject({
      taskBranch: TASK_BRANCH,
      commit: COMMIT_TWO,
    });
    expect(report.checks.map((entry) => entry.result)).toEqual(['failed', 'passed']);
    expect(report.reviewer).toMatchObject({ outcome: 'approved', attempt: 1 });
    expect(report.sections.plan.availability).toBe('available');
    expect(report.sections.reviewer.availability).toBe('available');
    expect(report.sections.checks.availability).toBe('available');
    expect(report.sections.journals.availability).toBe('empty-not-proven');
    expect(report.cleanup).toMatchObject({
      outcome: 'succeeded',
      detail: 'Disposed the runtime, role sessions, and run worktree.',
    });
    expect(report.sections.cleanup.availability).toBe('available');
    expect(report.failures.attempts).toHaveLength(1);
    expect(report.corrections).toHaveLength(1);
    expect(report.corrections[0]?.route).toBe('correction-required');
  });

  it('flags empty summaries as empty-not-proven rather than as proof', () => {
    const { history, runDirectory } = verifiedHistory(EMPTY_DRAFTS);
    const report = buildRunInspectReport({ runDirectory, history });

    expect(report.plan).toBeNull();
    expect(report.sections.plan.availability).toBe('empty-not-proven');
    expect(report.sections.checks.availability).toBe('empty-not-proven');
    expect(report.sections.findings.availability).toBe('empty-not-proven');
    expect(report.sections.cleanup.availability).toBe('empty-not-proven');
    expect(report.sections.plan.detail).toContain('not proof');
  });

  it('reports hashed evidence as verified and label-only claims as unverified', () => {
    const { history, runDirectory } = verifiedHistory(COMPLETED_DRAFTS);
    const report = buildRunInspectReport({ runDirectory, history });

    const hashedLog = report.captures.entries.find(
      (entry) => entry.source === 'verification-log' && entry.contentHash === 'c'.repeat(64),
    );
    expect(hashedLog?.verified).toBe(true);
    expect(hashedLog?.byteLength).toBe(12);

    const labelOnly = report.captures.entries.find((entry) =>
      entry.label.includes('manual screenshot login.png'),
    );
    expect(labelOnly).toMatchObject({ verified: false, contentHash: null });
    const duplicate = report.captures.duplicates.find((entry) => entry.contentHash === HASH_D);
    expect(duplicate?.labels.length).toBeGreaterThan(1);
  });

  it('summarizes the human decision from the settled Reviewer envelope', () => {
    const { history, runDirectory } = verifiedHistory(DECISION_DRAFTS);
    const report = buildRunInspectReport({ runDirectory, history });

    expect(report.workflowState).toBe('human_decision_required');
    expect(report.decision).not.toBeNull();
    expect(report.decision).toMatchObject({
      question: DECISION_QUESTION,
      recommendation: 'Keep the retry budget',
      commandsExact: false,
      commentAccepted: false,
      commentAcceptedKnown: false,
      resultCommit: COMMIT_ONE,
      sourceCommit: FROZEN_COMMIT,
    });
    expect(report.decision?.options.map((option) => option.id)).toEqual(['OPT-001', 'OPT-002']);
    expect(report.decision?.commands).toHaveLength(2);
    expect(report.decision?.commands[0]?.command).toBe(
      `/foundry decide ${RUN_ID} <decision-id> OPT-001 <nonce>`,
    );
    expect(report.decision?.unresolvedFindings.map((finding) => finding.id)).toEqual(['FND-001']);
    expect(report.sections.decision.availability).toBe('available');
    expect(report.sections.cleanup.availability).toBe('empty-not-proven');
  });

  it('enriches the decision with the optional publication records when present', () => {
    const { history, runDirectory } = verifiedHistory(DECISION_DRAFTS);
    const forwarded = withForwardEvents(history, [
      {
        type: 'decision-opened',
        payload: {
          decisionId: 'decision-0001',
          nonce: DECISION_NONCE,
          resultCommit: COMMIT_ONE,
        },
      },
      {
        type: 'publication-checkpoint',
        payload: {
          stage: 'url-recorded',
          draftPrUrl: 'https://example.invalid/pr/7',
          decisionId: 'decision-0001',
          detail: 'the exact draft PR URL was recorded',
        },
      },
      {
        type: 'decision-applied',
        payload: { decisionId: 'decision-0001', optionId: 'OPT-001', action: 'accept' },
      },
    ]);
    const report = buildRunInspectReport({ runDirectory, history: forwarded });

    expect(report.decision).toMatchObject({
      decisionId: 'decision-0001',
      draftPrUrl: 'https://example.invalid/pr/7',
      publicationStage: 'url-recorded',
      commandsExact: true,
      commentAccepted: true,
      commentAcceptedKnown: true,
    });
    expect(report.decision?.commands[0]?.command).toBe(
      `/foundry decide ${RUN_ID} decision-0001 OPT-001 ${DECISION_NONCE}`,
    );
  });
});

interface Fixture {
  readonly base: string;
  readonly configPath: string;
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(drafts: ReadonlyArray<RunEventDraft>): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-inspect-'));
  const target = join(base, 'target');
  const runDirectory = join(target, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  const configPath = join(base, 'foundry.config.json');
  writeFileSync(configPath, JSON.stringify(goldenConfigurationDocument(target)));
  const events = sealChain(RUN_ID, drafts);
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
    configPath,
    runDirectory,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const InspectCliLayer = Layer.mergeAll(ReadinessFilesLive, RunHistoryLive);

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

describe('inspect through the cli envelope', () => {
  it.effect('reports the inspected sections in json and human output', () =>
    Effect.gen(function* () {
      const fixture = setupFixture(COMPLETED_DRAFTS);
      try {
        const jsonResult = yield* runCli([
          'inspect',
          '--config',
          fixture.configPath,
          '--run-id',
          RUN_ID,
          '--json',
        ]).pipe(Effect.provide(InspectCliLayer));
        expect(jsonResult.exitCode).toBe(EXIT_CODES.reported);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(jsonResult.stdout);
        expect(envelope.ok).toBe(true);
        if (!envelope.ok || !('sections' in envelope.data)) {
          throw new Error(`Expected an inspect report but received: ${jsonResult.stdout}`);
        }
        expect(envelope.command).toBe('inspect');
        expect(envelope.data.runId).toBe(RUN_ID);
        expect(envelope.data.sections.plan.availability).toBe('available');
        expect(envelope.data.plan?.criteria[0]?.id).toBe('AC-001');
        expect(envelope.data.captures.entries.some((entry) => entry.verified)).toBe(true);
        expect(envelope.data.cleanup).toMatchObject({ outcome: 'succeeded' });

        const humanResult = yield* runCli([
          'inspect',
          '--config',
          fixture.configPath,
          '--run-id',
          RUN_ID,
        ]).pipe(Effect.provide(InspectCliLayer));
        expect(humanResult.exitCode).toBe(EXIT_CODES.reported);
        expect(humanResult.stdout).toContain('command: inspect');
        expect(humanResult.stdout).toContain('data.sections.plan: available');
        expect(humanResult.stdout).toContain('data.sections.decision: empty-not-proven');
        expect(humanResult.stdout).toContain('data.sections.cleanup: available');
        expect(humanResult.stdout).toContain('data.cleanup.outcome: succeeded');
        expect(humanResult.stdout).toContain(`data.plan.criteria: AC-001 commit=${COMMIT_TWO}`);
        expect(humanResult.stdout).toContain('data.reviewer.outcome: approved');
        expect(humanResult.stdout.endsWith('\n')).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('fails with a typed integrity envelope for corrupt history', () =>
    Effect.gen(function* () {
      const fixture = setupFixture(COMPLETED_DRAFTS);
      try {
        rmSync(join(fixture.runDirectory, RUN_HISTORY_FILENAME));
        const result = yield* runCli([
          'inspect',
          '--config',
          fixture.configPath,
          '--run-id',
          RUN_ID,
          '--json',
        ]).pipe(Effect.provide(InspectCliLayer));
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

describe('readRunInspect', () => {
  it.effect('reads a verified history without appending events', () =>
    Effect.gen(function* () {
      const fixture = setupFixture(COMPLETED_DRAFTS);
      try {
        const before = readFileSync(join(fixture.runDirectory, RUN_HISTORY_FILENAME), 'utf8');
        const report = yield* readRunInspect({
          configArg: fixture.configPath,
          cwd: '/',
          runId: RUN_ID,
        }).pipe(Effect.provide(InspectCliLayer));
        expect(report.workflowState).toBe('completed');
        expect(report.sections.captures.availability).toBe('available');
        const after = readFileSync(join(fixture.runDirectory, RUN_HISTORY_FILENAME), 'utf8');
        expect(after).toBe(before);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
