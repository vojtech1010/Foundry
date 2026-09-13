import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Schema } from 'effect';

import { RunGit } from '../src/application/git-provisioning/index.js';
import { buildHandoff } from '../src/application/handoff/index.js';
import { buildRunInspectReport } from '../src/application/inspect/index.js';
import { buildRolePacket } from '../src/application/role-packets/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { handleTesterTurn } from '../src/application/tester-validation/index.js';
import { sealRunEvent, verifyRunHistoryEvents } from '../src/domain/run-history.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RUN_ID, seedVerifyingRun } from './fixtures/checks-runtime-run.js';

import type { VerifiedRunHistory } from '../src/application/run-history/index.js';
import type { ProjectConfiguration } from '../src/domain/project-configuration.js';
import type { RoleHostSessionState } from '../src/domain/role-host.js';
import type {
  EvidenceManifestEntry,
  EvidenceManifestPayload,
  PlanAcceptedPayload,
  RunEvent,
  RunEventDraft,
  RunEventEnvelope,
  RunHistoryDerivedState,
  VerificationCompletedPayload,
} from '../src/domain/run-history.js';

const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const RESULT_COMMIT = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

const TASK_BRANCH = 'foundry/RUN-CAPTURES';

const WORKSPACE = '/target/.agent/worktrees/RUN-CAPTURES';

const HASH_A = 'a'.repeat(64);

const HASH_B = 'b'.repeat(64);

const HASH_C = 'c'.repeat(64);

const PLAN: PlanAcceptedPayload = {
  outcome: 'plan_ready',
  criteria: [
    { id: 'AC-001', text: 'the gallery is reachable' },
    { id: 'AC-002', text: 'the checks pass' },
  ],
  runtimeValidationRequired: false,
  execution: {
    mode: 'sequential',
    objectives: [
      {
        id: 'OBJ-001',
        title: 'Implement the accepted plan',
        affectedPaths: ['.'],
        criterionIds: ['AC-001', 'AC-002'],
      },
    ],
  },
};

const VERIFICATION: VerificationCompletedPayload = {
  attempt: 1,
  repository: '/target',
  commit: RESULT_COMMIT,
  profileHash: 'f'.repeat(64),
  commandMs: 1000,
  executions: [
    {
      kind: 'gate',
      name: 'typecheck',
      executable: 'npm',
      arguments: ['run', 'typecheck'],
      expectedExitCode: 0,
      actualExitCode: 0,
      timedOut: false,
      durationMs: 900,
      log: {
        path: 'logs/typecheck.log',
        sha256: HASH_C,
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
  result: 'passed',
};

const REVIEWER_SESSION: RoleHostSessionState = {
  role: 'reviewer',
  attempt: 1,
  generation: 1,
  sessionId: 'session-reviewer-1',
  ownershipToken: 'owner-reviewer-1',
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
  lastObservation: {
    status: 'settled',
    sequence: 1,
    eventCount: 1,
    narrative: 'Reviewer approved the exact result.',
    control: { schemaVersion: 1, outcome: 'approved' },
  },
  stopDisposition: null,
};

const COMPLETION = {
  state: 'completed' as const,
  route: 'review-approved' as const,
  from: 'reviewing' as const,
  at: '2026-01-01T00:00:00.000Z',
};

function derivedFor(
  evidenceManifests: ReadonlyArray<EvidenceManifestPayload>,
): RunHistoryDerivedState {
  return {
    state: 'completed',
    checkpoint: null,
    attempts: [],
    cleanupProgress: null,
    sourceFrozen: {
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
    guidanceFrozen: null,
    worktreeReady: null,
    roleSessions: [REVIEWER_SESSION],
    roleControlRepairs: [],
    acceptedPlan: PLAN,
    findings: [],
    implementation: {
      taskBranch: TASK_BRANCH,
      baseCommit: FROZEN_COMMIT,
      commit: RESULT_COMMIT,
      changedFiles: ['src/a.ts'],
      noChangeCandidate: false,
    },
    permissionViolations: [],
    verifications: [VERIFICATION],
    testerSkips: [
      {
        reason: 'The accepted plan does not require live application validation.',
        verificationCommit: RESULT_COMMIT,
      },
    ],
    validationLimitations: [],
    runtimeLifecycles: [],
    evidenceInvalidations: [],
    evidenceBindings: [],
    evidenceManifests,
  };
}

function configuration(maxRoleHandoffBytes: number): ProjectConfiguration {
  // SAFETY: packet assembly reads only artifacts.maxRoleHandoffBytes from configuration.
  return { artifacts: { maxRoleHandoffBytes } } as ProjectConfiguration;
}

const DUPLICATED_MANIFEST: EvidenceManifestPayload = {
  entries: [
    {
      sha256: HASH_A,
      byteLength: 12,
      label: 'authenticated settings',
      kind: 'capture',
      criterionIds: ['AC-001'],
    },
    {
      sha256: HASH_A,
      byteLength: 12,
      label: 'no-duplicate relogin overview',
      kind: 'capture',
      criterionIds: ['AC-001'],
    },
  ],
};

const INDEPENDENT_MANIFEST: EvidenceManifestPayload = {
  entries: [
    {
      sha256: HASH_B,
      byteLength: 20,
      label: 'overview',
      kind: 'capture',
      criterionIds: ['AC-001'],
    },
    {
      sha256: null,
      byteLength: null,
      label: 'manual screenshot login.png',
      kind: 'capture',
      criterionIds: ['AC-002'],
    },
  ],
};

const NOTE_ONLY_MANIFEST: EvidenceManifestPayload = {
  entries: [
    {
      sha256: HASH_B,
      byteLength: 20,
      label: 'copy nit: tighten the empty-state wording',
      kind: 'note',
      criterionIds: ['AC-001'],
    },
  ],
};

describe('captures count by content, not by filename or caption', () => {
  it('distinguishes a hashed capture from a name-only claim in the handoff', () => {
    const document = buildHandoff(
      'RUN-CAPTURES',
      derivedFor([INDEPENDENT_MANIFEST]),
      COMPLETION,
      [],
    );

    const hashed = document.captures.find((capture) => capture.label === 'overview');
    expect(hashed).toMatchObject({ hashed: true, duplicated: false, sha256: HASH_B });
    const nameOnly = document.captures.find(
      (capture) => capture.label === 'manual screenshot login.png',
    );
    expect(nameOnly).toMatchObject({ hashed: false, duplicated: false, sha256: null });
  });

  it('marks identical content under different labels as one duplicated capture', () => {
    const document = buildHandoff(
      'RUN-CAPTURES',
      derivedFor([DUPLICATED_MANIFEST]),
      COMPLETION,
      [],
    );

    expect(document.captures).toHaveLength(2);
    expect(document.captures.every((capture) => capture.duplicated)).toBe(true);
    expect(document.captures.every((capture) => capture.hashed)).toBe(true);
  });

  it('reports a criterion with only duplicated support as unproven', () => {
    const document = buildHandoff(
      'RUN-CAPTURES',
      derivedFor([DUPLICATED_MANIFEST]),
      COMPLETION,
      [],
    );

    expect(document.coverageComplete).toBe(false);
    expect(document.missingCoverage).toContain(
      'Criterion AC-001 is supported only by discounted captures (name-only, informational, or duplicated content) with no independent evidence.',
    );
  });

  it('does not let an informational copy or UX note prove a criterion', () => {
    const document = buildHandoff('RUN-CAPTURES', derivedFor([NOTE_ONLY_MANIFEST]), COMPLETION, []);

    expect(document.coverageComplete).toBe(false);
    expect(document.missingCoverage.some((entry) => entry.includes('Criterion AC-001'))).toBe(true);
  });

  it('keeps an independently hashed capture as proof of its criterion', () => {
    const onlyIndependent: EvidenceManifestPayload = {
      entries: [INDEPENDENT_MANIFEST.entries[0]!],
    };
    const document = buildHandoff('RUN-CAPTURES', derivedFor([onlyIndependent]), COMPLETION, []);

    expect(document.coverageComplete).toBe(true);
    expect(document.missingCoverage).toEqual([]);
  });

  it('does not fail an otherwise proven result when no gallery is captured', () => {
    const document = buildHandoff('RUN-CAPTURES', derivedFor([]), COMPLETION, []);

    expect(document.captures).toEqual([]);
    expect(document.coverageComplete).toBe(true);
    expect(document.missingCoverage).toEqual([]);
  });

  it('includes the manifest and a discounting instruction in the reviewer packet', () => {
    const packet = buildRolePacket({
      role: 'reviewer',
      request: 'the request',
      guidance: 'the guidance',
      history: derivedFor([INDEPENDENT_MANIFEST]),
      configuration: configuration(100_000),
    });
    expect(packet.ok).toBe(true);
    if (!packet.ok) {
      return;
    }
    expect(packet.prompt).toContain('Discount mislabeled or duplicated captures');
    expect(packet.prompt).toContain('2 capture(s): 1 hashed, 1 name-only');
    expect(packet.prompt).toContain('manual screenshot login.png');
  });

  it('names duplicated content in the reviewer packet so it is discounted', () => {
    const packet = buildRolePacket({
      role: 'reviewer',
      request: 'the request',
      guidance: 'the guidance',
      history: derivedFor([DUPLICATED_MANIFEST]),
      configuration: configuration(100_000),
    });
    expect(packet.ok).toBe(true);
    if (!packet.ok) {
      return;
    }
    expect(packet.prompt).toContain(`duplicated content: ${HASH_A}`);
    expect(packet.prompt).toContain('Identical content under different labels is one observation.');
  });

  it('does not surface the manifest to roles that do not consume it', () => {
    const packet = buildRolePacket({
      role: 'architect',
      request: 'the request',
      guidance: 'the guidance',
      history: derivedFor([DUPLICATED_MANIFEST]),
      configuration: configuration(100_000),
    });
    expect(packet.ok).toBe(true);
    if (!packet.ok) {
      return;
    }
    expect(packet.prompt).toContain('Tester capture manifests are surfaced to Reviewer only');
    expect(packet.prompt).not.toContain('authenticated settings');
    expect(packet.prompt).not.toContain('Discount mislabeled or duplicated captures');
  });
});

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
      occurredAt: '2026-09-13T00:00:00.000Z',
      previousEventHash: previousHash,
    };
    const sealed = sealRunEvent(envelope, draft);
    events.push(sealed);
    previousHash = sealed.eventHash;
  });
  return events;
}

function verifiedHistory(drafts: ReadonlyArray<RunEventDraft>): VerifiedRunHistory {
  const events = sealChain(RUN_ID, drafts);
  const verification = verifyRunHistoryEvents(events, RUN_ID);
  if (!verification.ok) {
    throw new Error(`Expected valid seeded history but received: ${verification.problem}`);
  }
  return {
    runId: RUN_ID,
    events,
    head: verification.head,
    derived: verification.derived,
    streamBytes: null,
    witnessBytes: null,
  };
}

const INSPECT_PROVISIONING: ReadonlyArray<RunEventDraft> = [
  { type: 'run-created', payload: { taskId: 'TASK-CAPTURES' } },
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
  {
    type: 'implementation-accepted',
    payload: {
      taskBranch: TASK_BRANCH,
      baseCommit: FROZEN_COMMIT,
      commit: RESULT_COMMIT,
      changedFiles: ['src/a.ts'],
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
];

const INSPECTION_DRAFTS: ReadonlyArray<RunEventDraft> = [
  ...INSPECT_PROVISIONING,
  {
    type: 'verification-completed',
    payload: {
      attempt: 1,
      repository: '/target',
      commit: RESULT_COMMIT,
      profileHash: 'f'.repeat(64),
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
            path: '/evidence/authenticated-settings.log',
            sha256: HASH_A,
            byteLength: 12,
            retainedByteLength: 12,
            truncated: false,
            redactionCount: 0,
          },
          trackedMutation: null,
          reconstructed: false,
          reconstructionError: null,
        },
        {
          kind: 'gate',
          name: 'lint',
          executable: 'lint',
          arguments: ['--check'],
          expectedExitCode: 0,
          actualExitCode: 0,
          timedOut: false,
          durationMs: 1,
          log: {
            path: '/evidence/no-duplicate-relogin-overview.log',
            sha256: HASH_A,
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
];

describe('inspection counts captures by content', () => {
  it('reports identical content under different names as one duplicate capture', () => {
    const history = verifiedHistory(INSPECTION_DRAFTS);
    const report = buildRunInspectReport({
      runDirectory: '/target/.agent/runs/RUN-CAPTURES',
      history,
    });

    const duplicate = report.captures.duplicates.find((entry) => entry.contentHash === HASH_A);
    expect(duplicate?.labels).toHaveLength(2);
    expect(report.captures.entries.filter((entry) => entry.contentHash === HASH_A)).toHaveLength(2);
    for (const entry of report.captures.entries.filter((e) => e.contentHash === HASH_A)) {
      expect(entry.verified).toBe(true);
    }
  });
});

function stubGit(): Layer.Layer<RunGit> {
  const unused = (name: string) =>
    Effect.die(new Error(`captures tests must not call RunGit.${name}`));
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
  const base = mkdtempSync(join(tmpdir(), `foundry-captures-${label}-`));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function seedTesting(runDirectory: string) {
  return Effect.gen(function* () {
    yield* seedVerifyingRun({ runDirectory, runtimeValidationRequired: true });
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'workflow-transition',
          payload: {
            route: 'checks-passed-testing',
            from: 'verifying',
            to: 'testing',
            checkpoint: null,
          },
        } as const),
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function handle(
  runDirectory: string,
  control: Schema.Json,
  captures: ReadonlyArray<EvidenceManifestEntry> = [],
) {
  return handleTesterTurn({
    runDirectory,
    runId: RUN_ID,
    control,
    commit: RESULT_COMMIT,
    testerRetriesRemaining: 1,
    retryReason: 'the Tester requested another observation',
    captures,
  }).pipe(Effect.provide(Live));
}

function readHistory(runDirectory: string) {
  return readVerifiedRunHistory({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

describe('the settled Tester turn records the capture manifest', () => {
  it.effect('persists hashed and name-only captures for the current result head', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('persisted');
      try {
        yield* seedTesting(fixture.runDirectory);
        const disposition = yield* handle(
          fixture.runDirectory,
          { schemaVersion: 1, outcome: 'observed' },
          [
            {
              sha256: HASH_A,
              byteLength: 12,
              label: 'settings',
              kind: 'capture',
              criterionIds: ['AC-001'],
            },
            {
              sha256: null,
              byteLength: null,
              label: 'login.png',
              kind: 'capture',
              criterionIds: ['AC-001'],
            },
          ],
        );
        expect(disposition).toEqual({ kind: 'observed' });

        const after = yield* readHistory(fixture.runDirectory);
        expect(after.derived.state).toBe('reviewing');
        expect(after.derived.evidenceManifests).toHaveLength(1);
        expect(after.derived.evidenceManifests[0]?.entries).toHaveLength(2);
        expect(after.derived.evidenceManifests[0]?.entries[0]).toMatchObject({
          sha256: HASH_A,
          kind: 'capture',
          criterionIds: ['AC-001'],
        });
        expect(after.derived.evidenceManifests[0]?.entries[1]?.sha256).toBeNull();
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('records an empty manifest when the turn offers no capture gallery', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('empty');
      try {
        yield* seedTesting(fixture.runDirectory);
        yield* handle(fixture.runDirectory, { schemaVersion: 1, outcome: 'observed' });

        const after = yield* readHistory(fixture.runDirectory);
        expect(after.derived.evidenceManifests).toHaveLength(1);
        expect(after.derived.evidenceManifests[0]?.entries).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
