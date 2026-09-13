import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RunHistoryConflict,
  RunHistoryIntegrityError,
  RunHistoryStorage,
  RunHistoryStorageError,
  appendRunEvent,
  readVerifiedRunHistory,
} from '../src/application/run-history/index.js';
import { RunIdentityStore, reconcileRunReports } from '../src/application/run-identity/index.js';
import {
  IllegalWorkflowTransition,
  transitionWorkflow,
} from '../src/application/workflow-transitions/index.js';
import {
  CLEANUP_PROGRESS_FILENAME,
  WORKFLOW_STATE_FILENAME,
  WorkflowProgressDocumentSchema,
} from '../src/domain/workflow.js';
import {
  RUN_HISTORY_FILENAME,
  RUN_HISTORY_WITNESS_FILENAME,
  RunEventSchema,
  RunHistoryWitnessSchema,
  computeRunEventHash,
  encodeRunEventLine,
  encodeRunHistoryWitness,
  sealRunEvent,
  unsignedRunEvent,
  verifyRunHistoryEvents,
} from '../src/domain/run-history.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';

import type {
  RoleSessionRepairContext,
  RunEvent,
  RunEventDraft,
  RunEventEnvelope,
} from '../src/domain/run-history.js';
import type { FindingRecord } from '../src/domain/findings.js';
import type { WorkflowTransitionRequest } from '../src/domain/workflow.js';

const RUN_ID = 'RUN-HISTORY';

const GENESIS_EVENT_ID = '00000000-0000-4000-8000-000000000001';

const SECOND_EVENT_ID = '00000000-0000-4000-8000-000000000002';

const OCCURRED_AT = '2026-09-13T00:00:00.000Z';

const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const TASK_BRANCH = 'foundry/run-history';

const WORKSPACE = '/repo/.agent/worktrees/run-history';

const RUN_CREATED: WorkflowTransitionRequest = {
  route: 'run-created',
  provisioning: { source: true, lease: true, storage: true, worktree: true },
};

const PLAN_ACCEPTED: WorkflowTransitionRequest = {
  route: 'plan-accepted',
};

const AppLive = Layer.mergeAll(RunHistoryLive, RunIdentityLive);

interface Fixture {
  readonly runDirectory: string;
  readonly streamPath: string;
  readonly witnessPath: string;
  readonly cleanup: () => void;
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-run-history-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    streamPath: join(runDirectory, RUN_HISTORY_FILENAME),
    witnessPath: join(runDirectory, RUN_HISTORY_WITNESS_FILENAME),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function seedProvisioning(runDirectory: string) {
  return Effect.gen(function* () {
    yield* appendRunEvent({
      runDirectory,
      runId: RUN_ID,
      createIfMissing: true,
      build: () => Effect.succeed({ type: 'run-created', payload: { taskId: 'TASK-1' } } as const),
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
            sourceCommit: FROZEN_COMMIT,
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
            headCommit: FROZEN_COMMIT,
            baseCommit: FROZEN_COMMIT,
          },
        } as const),
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function createRun(runDirectory: string) {
  return Effect.gen(function* () {
    yield* seedProvisioning(runDirectory);
    yield* transitionWorkflow({
      runDirectory,
      runId: RUN_ID,
      request: RUN_CREATED,
    });
  }).pipe(Effect.provide(AppLive));
}

function appendAcceptedPlan(
  runDirectory: string,
  outcome: 'plan_ready' | 'no_change_candidate' = 'plan_ready',
) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'plan-accepted',
        payload: {
          outcome,
          criteria: [{ id: 'AC-001', text: 'the seeded criterion' }],
          runtimeValidationRequired: false,
          execution: {
            mode: 'sequential' as const,
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
      } as const),
  }).pipe(Effect.provide(RunHistoryLive));
}

function verifyHistory(runDirectory: string) {
  return readVerifiedRunHistory({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

const RunEventJson = Schema.fromJsonString(RunEventSchema);

function readEvents(runDirectory: string): ReadonlyArray<RunEvent> {
  const lines = readFileSync(join(runDirectory, RUN_HISTORY_FILENAME), 'utf8').split('\n');
  lines.pop();
  return lines.map((line) =>
    Schema.decodeUnknownSync(RunEventJson, { onExcessProperty: 'error' })(line),
  );
}

function writeStream(runDirectory: string, text: string): void {
  writeFileSync(join(runDirectory, RUN_HISTORY_FILENAME), text);
}

function expectIntegrity(cause: unknown, expectedText: string): RunHistoryIntegrityError {
  expect(cause).toBeInstanceOf(RunHistoryIntegrityError);
  if (!(cause instanceof RunHistoryIntegrityError)) {
    throw new Error(`Expected a run history integrity error but received: ${String(cause)}`);
  }
  expect(cause.message).toContain('investigate run integrity');
  expect(cause.message).toContain(expectedText);
  return cause;
}

function genesisEnvelope(runId: string): RunEventEnvelope {
  return {
    schemaVersion: 1,
    runId,
    revision: 1,
    eventId: GENESIS_EVENT_ID,
    occurredAt: OCCURRED_AT,
    previousEventHash: null,
  };
}

describe('run history event contract', () => {
  it('seals closed events with a canonical chained hash', () => {
    const envelope = genesisEnvelope('RUN-1');
    const draft = {
      type: 'workflow-transition',
      payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
    } satisfies RunEventDraft;
    const sealed = sealRunEvent(envelope, draft);

    const canonicalBody =
      '{"eventId":"00000000-0000-4000-8000-000000000001","occurredAt":"2026-09-13T00:00:00.000Z","payload":{"checkpoint":null,"from":null,"route":"run-created","to":"planning"},"previousEventHash":null,"revision":1,"runId":"RUN-1","schemaVersion":1,"type":"workflow-transition"}';
    const expectedHash = createHash('sha256').update(`\n${canonicalBody}`, 'utf8').digest('hex');

    expect(sealed.eventHash).toBe(expectedHash);
    expect(computeRunEventHash(unsignedRunEvent(sealed))).toBe(expectedHash);

    const decoded = Schema.decodeUnknownSync(RunEventJson, { onExcessProperty: 'error' })(
      JSON.stringify(sealed),
    );
    expect(decoded).toEqual(sealed);

    for (const invalid of [
      { ...sealed, type: 'unknown-event' },
      { ...sealed, payload: { ...sealed.payload, extra: true } },
      { ...sealed, revision: 1.5 },
      { ...sealed, eventId: 'not-a-uuid' },
      { ...sealed, occurredAt: '2026-09-13' },
      { ...sealed, eventHash: 'not-a-hash' },
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(RunEventJson, { onExcessProperty: 'error' })(
          JSON.stringify(invalid),
        ),
      ).toThrow();
    }
  });

  it('keeps the chain verifiable and rejects broken payload semantics', () => {
    const genesis = sealRunEvent(genesisEnvelope('RUN-1'), {
      type: 'run-created',
      payload: { taskId: 'TASK-1' },
    });
    const transition = sealRunEvent(
      {
        ...genesisEnvelope('RUN-1'),
        revision: 2,
        eventId: SECOND_EVENT_ID,
        previousEventHash: genesis.eventHash,
      },
      {
        type: 'workflow-transition',
        payload: { route: 'review-approved', from: 'planning', to: 'completed', checkpoint: null },
      },
    );

    const illegal = verifyRunHistoryEvents([genesis, transition], 'RUN-1');
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) {
      expect(illegal.problem).toContain('does not continue');
    }

    const mismatchedRun = verifyRunHistoryEvents([genesis], 'RUN-OTHER');
    expect(mismatchedRun.ok).toBe(false);
    if (!mismatchedRun.ok) {
      expect(mismatchedRun.problem).toContain('RUN-1');
    }

    const tamperedHash: RunEvent = { ...genesis, eventHash: 'f'.repeat(64) };
    const hashProblem = verifyRunHistoryEvents([tamperedHash], 'RUN-1');
    expect(hashProblem.ok).toBe(false);
    if (!hashProblem.ok) {
      expect(hashProblem.problem).toContain('hash does not match');
    }

    const gap = verifyRunHistoryEvents([genesis, transition], 'RUN-1');
    expect(gap.ok).toBe(false);
  });
});

describe('append-only run history with live storage', () => {
  it.effect('appends consecutive chained events and preserves rejected operations', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* createRun(fixture.runDirectory);
        yield* appendAcceptedPlan(fixture.runDirectory);
        yield* transitionWorkflow({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          request: PLAN_ACCEPTED,
        }).pipe(Effect.provide(AppLive));

        const events = readEvents(fixture.runDirectory);
        expect(events.map((event) => event.revision)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(events[0]).toMatchObject({ previousEventHash: null });
        expect(events[6]).toMatchObject({ previousEventHash: events[5]?.eventHash });
        expect(verifyRunHistoryEvents(events, RUN_ID).ok).toBe(true);

        const witness = Schema.decodeUnknownSync(Schema.fromJsonString(RunHistoryWitnessSchema), {
          onExcessProperty: 'error',
        })(readFileSync(fixture.witnessPath, 'utf8'));
        expect(witness).toEqual({
          schemaVersion: 1,
          runId: RUN_ID,
          revision: 7,
          eventHash: events[6]?.eventHash,
        });

        const before = readFileSync(fixture.streamPath, 'utf8');
        const refusal = yield* transitionWorkflow({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          request: PLAN_ACCEPTED,
        }).pipe(Effect.provide(AppLive), Effect.flip);
        expect(refusal).toBeInstanceOf(IllegalWorkflowTransition);
        expect(readFileSync(fixture.streamPath, 'utf8')).toBe(before);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('detects every truncated, malformed, or discontinuous history', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* createRun(fixture.runDirectory);
        yield* appendAcceptedPlan(fixture.runDirectory);
        yield* transitionWorkflow({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          request: PLAN_ACCEPTED,
        }).pipe(Effect.provide(AppLive));

        const validStream = readFileSync(fixture.streamPath, 'utf8');
        const validWitness = readFileSync(fixture.witnessPath, 'utf8');

        const removeLastLine = (text: string): string => {
          const lines = text.split('\n');
          lines.pop();
          lines.pop();
          return `${lines.join('\n')}\n`;
        };

        writeStream(fixture.runDirectory, removeLastLine(validStream));
        const truncated = yield* verifyHistory(fixture.runDirectory).pipe(Effect.flip);
        expectIntegrity(truncated, 'witness does not match');
        expect(readFileSync(fixture.streamPath, 'utf8')).toBe(removeLastLine(validStream));

        writeStream(fixture.runDirectory, `${validStream}not json\n`);
        const malformed = yield* verifyHistory(fixture.runDirectory).pipe(Effect.flip);
        expectIntegrity(malformed, 'not a valid event');

        writeStream(fixture.runDirectory, validStream.slice(0, -1));
        const noTerminalNewline = yield* verifyHistory(fixture.runDirectory).pipe(Effect.flip);
        expectIntegrity(noTerminalNewline, 'terminal newline');

        writeStream(fixture.runDirectory, validStream.replace('"revision":2', '"revision":3'));
        const revisionGap = yield* verifyHistory(fixture.runDirectory).pipe(Effect.flip);
        expectIntegrity(revisionGap, 'revision');

        writeStream(fixture.runDirectory, validStream.replace('"to":"coding"', '"to":"reviewing"'));
        const tamperedPayload = yield* verifyHistory(fixture.runDirectory).pipe(Effect.flip);
        expectIntegrity(tamperedPayload, 'hash does not match');

        writeStream(fixture.runDirectory, validStream);
        rmSync(fixture.witnessPath);
        const missingWitness = yield* verifyHistory(fixture.runDirectory).pipe(Effect.flip);
        expectIntegrity(missingWitness, 'witness is missing');

        writeFileSync(fixture.witnessPath, validWitness);
        rmSync(fixture.streamPath);
        const missingStream = yield* verifyHistory(fixture.runDirectory).pipe(Effect.flip);
        expectIntegrity(missingStream, 'witness remains');

        mkdirSync(fixture.streamPath);
        const directoryStream = yield* verifyHistory(fixture.runDirectory).pipe(Effect.flip);
        expectIntegrity(directoryStream, 'not a regular file');

        rmSync(fixture.streamPath, { recursive: true });
        rmSync(fixture.witnessPath);
        const absentHistory = yield* verifyHistory(fixture.runDirectory).pipe(Effect.flip);
        expectIntegrity(absentHistory, 'no canonical history stream');

        writeFileSync(fixture.witnessPath, validWitness);
        writeStream(fixture.runDirectory, '');
        const emptyStream = yield* verifyHistory(fixture.runDirectory).pipe(Effect.flip);
        expectIntegrity(emptyStream, 'terminal newline');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('detects a history that belongs to another run', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const foreignGenesis = sealRunEvent(genesisEnvelope('RUN-OTHER'), {
          type: 'run-created',
          payload: { taskId: 'TASK-1' },
        });
        writeFileSync(fixture.streamPath, Buffer.from(encodeRunEventLine(foreignGenesis)));
        writeFileSync(
          fixture.witnessPath,
          Buffer.from(
            encodeRunHistoryWitness({
              schemaVersion: 1,
              runId: RUN_ID,
              revision: 1,
              eventHash: foreignGenesis.eventHash,
            }),
          ),
        );

        const error = yield* verifyHistory(fixture.runDirectory).pipe(Effect.flip);
        expectIntegrity(error, 'RUN-OTHER');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('collision handling and interrupted publication', () => {
  it.effect('re-reads and re-evaluates a stale writer against the real latest history', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* createRun(fixture.runDirectory);
        yield* appendAcceptedPlan(fixture.runDirectory);
        const live = yield* RunHistoryStorage.pipe(Effect.provide(RunHistoryLive));
        const identity = yield* RunIdentityStore.pipe(Effect.provide(RunIdentityLive));

        let injected = false;
        const proxy = RunHistoryStorage.of({
          ...live,
          readHistoryFiles: (runDirectory: string) =>
            Effect.gen(function* () {
              const snapshot = yield* live.readHistoryFiles(runDirectory);
              if (!injected) {
                injected = true;
                yield* appendRunEvent({
                  runDirectory,
                  runId: RUN_ID,
                  createIfMissing: false,
                  build: () =>
                    Effect.succeed<RunEventDraft>({
                      type: 'cleanup-progress',
                      payload: { outcome: 'warning', detail: 'competing writer' },
                    }),
                }).pipe(Effect.provideService(RunHistoryStorage, live), Effect.orDie);
              }
              return snapshot;
            }),
        });

        const report = yield* transitionWorkflow({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          request: PLAN_ACCEPTED,
        }).pipe(
          Effect.provideService(RunHistoryStorage, proxy),
          Effect.provideService(RunIdentityStore, identity),
        );
        expect(report.workflowState).toBe('coding');

        const events = readEvents(fixture.runDirectory);
        expect(events).toHaveLength(8);
        expect(events.map((event) => event.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(events[6]).toMatchObject({
          type: 'cleanup-progress',
          payload: { outcome: 'warning', detail: 'competing writer' },
        });
        expect(events[7]).toMatchObject({
          type: 'workflow-transition',
          payload: { route: 'plan-accepted', from: 'planning', to: 'coding' },
        });
        expect(verifyRunHistoryEvents(events, RUN_ID).ok).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('returns a typed refusal when the winner made the operation illegal', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* createRun(fixture.runDirectory);
        yield* appendAcceptedPlan(fixture.runDirectory);
        const live = yield* RunHistoryStorage.pipe(Effect.provide(RunHistoryLive));
        const identity = yield* RunIdentityStore.pipe(Effect.provide(RunIdentityLive));

        let injected = false;
        const proxy = RunHistoryStorage.of({
          ...live,
          readHistoryFiles: (runDirectory: string) =>
            Effect.gen(function* () {
              const snapshot = yield* live.readHistoryFiles(runDirectory);
              if (!injected) {
                injected = true;
                yield* transitionWorkflow({
                  runDirectory,
                  runId: RUN_ID,
                  request: PLAN_ACCEPTED,
                }).pipe(
                  Effect.provideService(RunHistoryStorage, live),
                  Effect.provideService(RunIdentityStore, identity),
                  Effect.orDie,
                );
              }
              return snapshot;
            }),
        });

        const refusal = yield* transitionWorkflow({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          request: PLAN_ACCEPTED,
        }).pipe(
          Effect.provideService(RunHistoryStorage, proxy),
          Effect.provideService(RunIdentityStore, identity),
          Effect.flip,
        );
        expect(refusal).toBeInstanceOf(IllegalWorkflowTransition);
        if (!(refusal instanceof IllegalWorkflowTransition)) {
          throw new Error('Expected an IllegalWorkflowTransition.');
        }
        expect(refusal.from).toBe('coding');
        expect(refusal.route).toBe('plan-accepted');

        const events = readEvents(fixture.runDirectory);
        expect(events).toHaveLength(7);
        expect(events[6]).toMatchObject({
          type: 'workflow-transition',
          payload: { route: 'plan-accepted', from: 'planning', to: 'coding' },
        });
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('bounded retries stop with a typed conflict instead of overwriting', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* createRun(fixture.runDirectory);
        const live = yield* RunHistoryStorage.pipe(Effect.provide(RunHistoryLive));
        const conflicting = RunHistoryStorage.of({
          ...live,
          commitHistory: () =>
            Effect.fail(new RunHistoryConflict({ message: 'forced conflict', runId: RUN_ID })),
        });

        const error = yield* appendRunEvent({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
          build: () =>
            Effect.succeed<RunEventDraft>({
              type: 'cleanup-progress',
              payload: { outcome: 'succeeded', detail: 'never accepted' },
            }),
        }).pipe(Effect.provideService(RunHistoryStorage, conflicting), Effect.flip);
        expect(error).toBeInstanceOf(RunHistoryConflict);
        expect(readEvents(fixture.runDirectory)).toHaveLength(5);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('stops for human investigation when publication was interrupted', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* createRun(fixture.runDirectory);
        const live = yield* RunHistoryStorage.pipe(Effect.provide(RunHistoryLive));
        const interrupted = RunHistoryStorage.of({
          ...live,
          commitHistory: (options) =>
            Effect.gen(function* () {
              yield* live.commitHistory({
                ...options,
                nextStreamBytes: options.expectedStreamBytes ?? new Uint8Array(),
              });
              return yield* new RunHistoryStorageError({
                message: 'simulated interruption after the witness write',
                runId: RUN_ID,
              });
            }),
        });

        const error = yield* appendRunEvent({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
          build: () =>
            Effect.succeed<RunEventDraft>({
              type: 'cleanup-progress',
              payload: { outcome: 'failed', detail: 'interrupted' },
            }),
        }).pipe(Effect.provideService(RunHistoryStorage, interrupted), Effect.flip);
        expect(error).toBeInstanceOf(RunHistoryStorageError);

        const events = readEvents(fixture.runDirectory);
        expect(events).toHaveLength(5);
        const integrity = yield* verifyHistory(fixture.runDirectory).pipe(Effect.flip);
        expectIntegrity(integrity, 'witness does not match');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('keeps the accepted prefix intact when a publication fails outright', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* createRun(fixture.runDirectory);
        const before = readFileSync(fixture.streamPath, 'utf8');
        const live = yield* RunHistoryStorage.pipe(Effect.provide(RunHistoryLive));
        const failing = RunHistoryStorage.of({
          ...live,
          commitHistory: () =>
            Effect.fail(new RunHistoryStorageError({ message: 'disk is full', runId: RUN_ID })),
        });

        const error = yield* appendRunEvent({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
          build: () =>
            Effect.succeed<RunEventDraft>({
              type: 'cleanup-progress',
              payload: { outcome: 'warning', detail: 'not accepted' },
            }),
        }).pipe(Effect.provideService(RunHistoryStorage, failing), Effect.flip);
        expect(error).toBeInstanceOf(RunHistoryStorageError);
        expect(readFileSync(fixture.streamPath, 'utf8')).toBe(before);

        const history = yield* verifyHistory(fixture.runDirectory);
        expect(history.head.revision).toBe(5);
        expect(history.derived.state).toBe('planning');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('replaces derived reports only against the expected head', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* createRun(fixture.runDirectory);
        const live = yield* RunHistoryStorage.pipe(Effect.provide(RunHistoryLive));
        const history = yield* verifyHistory(fixture.runDirectory);
        const reportPath = join(fixture.runDirectory, WORKFLOW_STATE_FILENAME);
        const originalBytes = readFileSync(reportPath);

        yield* live.replaceDerivedReports({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          expectedStreamBytes: history.streamBytes,
          expectedWitnessBytes: history.witnessBytes,
          writes: [{ path: reportPath, bytes: new Uint8Array(originalBytes) }],
          removals: [],
        });
        expect(readFileSync(reportPath)).toEqual(originalBytes);

        const stale = yield* live
          .replaceDerivedReports({
            runDirectory: fixture.runDirectory,
            runId: RUN_ID,
            expectedStreamBytes: new Uint8Array(),
            expectedWitnessBytes: history.witnessBytes,
            writes: [{ path: reportPath, bytes: new TextEncoder().encode('{"stale":true}\n') }],
            removals: [],
          })
          .pipe(Effect.flip);
        expect(stale).toBeInstanceOf(RunHistoryConflict);
        expect(readFileSync(reportPath)).toEqual(originalBytes);

        rmSync(reportPath);
        mkdirSync(reportPath);
        const notRegular = yield* live
          .replaceDerivedReports({
            runDirectory: fixture.runDirectory,
            runId: RUN_ID,
            expectedStreamBytes: history.streamBytes,
            expectedWitnessBytes: history.witnessBytes,
            writes: [{ path: reportPath, bytes: new TextEncoder().encode('{"x":1}\n') }],
            removals: [],
          })
          .pipe(Effect.flip);
        expect(notRegular).toBeInstanceOf(RunHistoryStorageError);
        if (!(notRegular instanceof RunHistoryStorageError)) {
          throw new Error('Expected a run history storage error.');
        }
        expect(notRegular.message).toContain('not a regular file');
        expect(statSync(reportPath).isDirectory()).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('never publishes an older replay over a newer accepted head', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* createRun(fixture.runDirectory);
        yield* appendAcceptedPlan(fixture.runDirectory);
        const live = yield* RunHistoryStorage.pipe(Effect.provide(RunHistoryLive));

        let injected = false;
        const racing = RunHistoryStorage.of({
          ...live,
          replaceDerivedReports: (options: Parameters<typeof live.replaceDerivedReports>[0]) =>
            Effect.gen(function* () {
              if (!injected) {
                injected = true;
                yield* transitionWorkflow({
                  runDirectory: fixture.runDirectory,
                  runId: RUN_ID,
                  request: PLAN_ACCEPTED,
                }).pipe(Effect.provideService(RunHistoryStorage, live), Effect.orDie);
              }
              return yield* live.replaceDerivedReports(options);
            }),
        });

        const progress = yield* reconcileRunReports({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
        }).pipe(Effect.provideService(RunHistoryStorage, racing));

        expect(progress.workflowState).toBe('coding');
        expect(progress.revision).toBe(7);
        expect(progress.eventHash).not.toBeNull();
        const document = Schema.decodeUnknownSync(WorkflowProgressDocumentSchema, {
          onExcessProperty: 'error',
        })(JSON.parse(readFileSync(join(fixture.runDirectory, WORKFLOW_STATE_FILENAME), 'utf8')));
        expect(document).toEqual({
          schemaVersion: 2,
          runId: RUN_ID,
          state: 'coding',
          checkpoint: null,
          attempts: [],
        });
        expect(readEvents(fixture.runDirectory)).toHaveLength(7);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('removes a cleanup report that has no backing cleanup event', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* createRun(fixture.runDirectory);
        const cleanupPath = join(fixture.runDirectory, CLEANUP_PROGRESS_FILENAME);
        writeFileSync(cleanupPath, '{"schemaVersion":1,"runId":"RUN-HISTORY"}\n');

        const progress = yield* reconcileRunReports({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
        }).pipe(Effect.provide(RunHistoryLive));

        expect(progress.cleanupProgress).toBeNull();
        expect(progress.workflowState).toBe('planning');
        expect(existsSync(cleanupPath)).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

const IMPLEMENTED_COMMIT = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

const RUNTIME_IDENTITY = {
  adapterVersion: 'test',
  provider: 'test',
  model: 'test',
  toolProfile: 'test',
};

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

const PROVISIONING_DRAFTS: ReadonlyArray<RunEventDraft> = [
  { type: 'run-created', payload: { taskId: 'TASK-1' } },
  {
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
      criteria: [{ id: 'AC-001', text: 'the criterion' }],
      runtimeValidationRequired: false,
      execution: {
        mode: 'sequential',
        objectives: [
          { id: 'OBJ-001', title: 'implement', affectedPaths: ['.'], criterionIds: ['AC-001'] },
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
      commit: IMPLEMENTED_COMMIT,
      changedFiles: ['src/a.ts'],
      noChangeCandidate: false,
    },
  },
  {
    type: 'workflow-transition',
    payload: { route: 'implementation-ready', from: 'coding', to: 'verifying', checkpoint: null },
  },
];

function findingDraft(overrides: Partial<FindingRecord> = {}): RunEventDraft {
  return {
    type: 'finding-recorded',
    payload: {
      id: 'FND-001',
      category: 'check',
      source: 'failed-check',
      owner: 'coder',
      severity: 'high',
      blocking: true,
      commit: IMPLEMENTED_COMMIT,
      description: 'Required command "lint" exited with code 1; the deterministic gate failed.',
      detail: 'The deterministic project command "lint" did not pass.',
      evidence: ['log /evidence/lint.log sha256:' + 'b'.repeat(64)],
      ...overrides,
    },
  };
}

describe('durable finding records and repair submissions', () => {
  it('accepts a commit-bound finding and exposes it as derived state', () => {
    const events = sealChain(RUN_ID, [...PROVISIONING_DRAFTS, findingDraft()]);
    const verification = verifyRunHistoryEvents(events, RUN_ID);
    expect(verification.ok).toBe(true);
    if (verification.ok) {
      expect(verification.derived.findings).toEqual([findingDraft().payload]);
    }
  });

  it('refuses a finding for a commit other than the current result head', () => {
    const events = sealChain(RUN_ID, [
      ...PROVISIONING_DRAFTS,
      findingDraft({ commit: 'c'.repeat(40) }),
    ]);
    const verification = verifyRunHistoryEvents(events, RUN_ID);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.problem).toContain('other than the current result head');
    }
  });

  it('refuses a reused finding id for the same commit', () => {
    const events = sealChain(RUN_ID, [
      ...PROVISIONING_DRAFTS,
      findingDraft(),
      findingDraft({ description: 'a different summary' }),
    ]);
    const verification = verifyRunHistoryEvents(events, RUN_ID);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.problem).toContain('reuses the finding id');
    }
  });

  const rejectedNarrative = '# Result\n\nThe original rejected narrative.';
  const rejectedControl = { schemaVersion: 1, outcome: 'bogus' };
  const repairedControl = { schemaVersion: 1, outcome: 'implemented' };
  const rejectedNarrativeHash = createHash('sha256')
    .update(rejectedNarrative, 'utf8')
    .digest('hex');
  const rejectedControlHash = createHash('sha256')
    .update(JSON.stringify(rejectedControl), 'utf8')
    .digest('hex');

  const sessionDrafts: ReadonlyArray<RunEventDraft> = [
    ...PROVISIONING_DRAFTS,
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
        narrative: rejectedNarrative,
        control: rejectedControl,
      },
    },
  ];

  function repairSubmissionDraft(
    repairOverrides: Partial<RoleSessionRepairContext> = {},
  ): RunEventDraft {
    return {
      type: 'role-session-submission-requested',
      payload: {
        sessionId: 'session-1',
        generation: 1,
        kind: 'repair',
        idempotencyKey: 'key-2',
        promptHash: 'd'.repeat(64),
        baselineSequence: 1,
        repair: {
          rejectedSequence: 1,
          rejectedControl,
          rejectedNarrativeHash,
          rejectedControlHash,
          validationError: 'the control envelope is invalid',
          ...repairOverrides,
        },
      },
    };
  }

  const repairCompletion: ReadonlyArray<RunEventDraft> = [
    {
      type: 'role-session-submission-started',
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
        narrative: rejectedNarrative,
        control: repairedControl,
      },
    },
  ];

  it('accepts a same-session repair that preserves the original narrative', () => {
    const events = sealChain(RUN_ID, [
      ...sessionDrafts,
      repairSubmissionDraft(),
      ...repairCompletion,
    ]);
    const verification = verifyRunHistoryEvents(events, RUN_ID);
    expect(verification.ok).toBe(true);
    if (verification.ok) {
      const session = verification.derived.roleSessions[0];
      expect(session?.submission?.idempotencyKey).toBe('key-2');
      expect(session?.lastObservation?.sequence).toBe(2);
    }
  });

  it('refuses a repair that does not preserve the rejected narrative hash', () => {
    const events = sealChain(RUN_ID, [
      ...sessionDrafts,
      repairSubmissionDraft({ rejectedNarrativeHash: '0'.repeat(64) }),
      ...repairCompletion,
    ]);
    const verification = verifyRunHistoryEvents(events, RUN_ID);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.problem).toContain('does not preserve the rejected narrative');
    }
  });

  it('refuses a repaired observation whose narrative changed', () => {
    const events = sealChain(RUN_ID, [
      ...sessionDrafts,
      repairSubmissionDraft(),
      {
        type: 'role-session-submission-started',
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
          narrative: '# Result\n\nA changed narrative.',
          control: repairedControl,
        },
      },
    ]);
    const verification = verifyRunHistoryEvents(events, RUN_ID);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.problem).toContain('changed the original narrative');
    }
  });

  it('refuses a repair submission without a settled rejected report', () => {
    const events = sealChain(RUN_ID, [
      ...PROVISIONING_DRAFTS,
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
      repairSubmissionDraft(),
    ]);
    const verification = verifyRunHistoryEvents(events, RUN_ID);
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.problem).toContain('settled rejected report');
    }
  });
});
