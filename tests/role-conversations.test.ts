import { describe, expect, it } from '@effect/vitest';
import { Duration, Effect, Fiber, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  ROLE_HOST_PROTOCOL_VERSION,
  RoleHostCreateRequestSchema,
  RoleHostObserveResponseSchema,
  RoleHostStopResponseSchema,
  RoleHostSubmitResponseSchema,
} from '../src/domain/role-host.js';
import { sealRunEvent, verifyRunHistoryEvents } from '../src/domain/run-history.js';
import {
  RoleConversationError,
  RoleHost,
  RoleHostOperationalError,
  startOrResumeRoleTurn,
  stopRoleSession,
} from '../src/application/role-conversations/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { roleHostProcessLayer } from '../src/platform/role-host.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { CAPABLE_ROLE_HOST_CAPABILITIES } from './fixtures/role-host/role-host-launcher.js';

import type {
  RoleHostCreateRequest,
  RoleHostCreateResponse,
  RoleHostObserveRequest,
  RoleHostObserveResponse,
  RoleHostOperation,
  RoleHostRuntimeIdentity,
  RoleHostStopRequest,
  RoleHostStopResponse,
  RoleHostSubmitRequest,
  RoleHostSubmitResponse,
} from '../src/domain/role-host.js';
import type { StartOrResumeRoleTurnOptions } from '../src/application/role-conversations/index.js';
import type { RunEvent, RunEventDraft } from '../src/domain/run-history.js';

const PARSE_OPTIONS = { onExcessProperty: 'error' } as const;

const RUN_ID = 'RUN-ROLE';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/role-host/fake-role-host.mjs', import.meta.url),
);

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

const FIXTURE_IDENTITY = {
  adapterVersion: 'fake-1',
  provider: 'fake-provider',
  model: 'fake-model',
  toolProfile: 'fake-profile',
} as const;

interface RunFixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupRun(): RunFixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-role-conversations-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

interface LogFixture {
  readonly logPath: string;
  readonly cleanup: () => void;
}

function setupLog(): LogFixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-role-host-log-'));
  return {
    logPath: join(base, 'invocations.jsonl'),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const RecordedInvocationSchema = Schema.Struct({
  operation: Schema.String,
  argv: Schema.Array(Schema.String),
  env: Schema.Struct({
    FOUNDRY_FAKE_TOKEN: Schema.NullOr(Schema.String),
    FOUNDRY_FAKE_UNLISTED: Schema.NullOr(Schema.String),
  }),
  request: Schema.NullOr(Schema.Json),
});

type RecordedInvocation = (typeof RecordedInvocationSchema)['Type'];

const RecordedInvocationJson = Schema.fromJsonString(RecordedInvocationSchema);

function readInvocations(logPath: string): ReadonlyArray<RecordedInvocation> {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => Schema.decodeUnknownSync(RecordedInvocationJson, PARSE_OPTIONS)(line));
}

function seedRunCreated(runDirectory: string) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: true,
    build: () => Effect.succeed({ type: 'run-created', payload: { taskId: 'TASK-1' } } as const),
  }).pipe(Effect.provide(RunHistoryLive));
}

function baseTurnOptions(runDirectory: string): StartOrResumeRoleTurnOptions {
  return {
    runDirectory,
    runId: RUN_ID,
    role: 'coder',
    attempt: 1,
    generation: 1,
    prompt: 'Implement the requested slice.',
    deadline: '2026-09-13T00:00:00.000Z',
    pollMs: 0,
    turnTimeoutMs: 60_000,
  };
}

function readRecordedSession(runDirectory: string) {
  return readVerifiedRunHistory({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(
    Effect.provide(RunHistoryLive),
    Effect.map((history) => history.derived.roleSessions.at(0) ?? null),
  );
}

const SETTLED_RESPONSE: RoleHostObserveResponse = {
  schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
  status: 'settled',
  sequence: 2,
  events: [{ sequence: 2, kind: 'message', text: 'finished' }],
  narrative: '# Result\n\nImplemented.',
  control: { schemaVersion: 1, outcome: 'implemented' },
};

const ACTIVE_RESPONSE: RoleHostObserveResponse = {
  schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
  status: 'active',
  sequence: 1,
  events: [{ sequence: 1, kind: 'message', text: 'working' }],
};

const LOST_RESPONSE: RoleHostObserveResponse = {
  schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
  status: 'lost',
  sequence: 1,
  events: [],
};

interface FakeRoleHostOptions {
  readonly sessionId: string;
  readonly ownershipToken: string;
  readonly generation: number;
  readonly initialSequence: number;
  readonly observeResponses: ReadonlyArray<RoleHostObserveResponse>;
  readonly createGeneration?: number;
  readonly submitFails?: boolean;
  readonly identity?: RoleHostRuntimeIdentity;
}

interface FakeRoleHost {
  readonly layer: Layer.Layer<RoleHost>;
  readonly calls: Array<RoleHostOperation>;
  readonly submitKeys: Array<string>;
}

function fakeRoleHost(options: FakeRoleHostOptions): FakeRoleHost {
  const calls: Array<RoleHostOperation> = [];
  const submitKeys: Array<string> = [];
  let observeIndex = 0;
  const layer = Layer.succeed(
    RoleHost,
    RoleHost.of({
      capabilities: () => {
        calls.push('capabilities');
        return Effect.succeed(CAPABLE_ROLE_HOST_CAPABILITIES);
      },
      create: (): Effect.Effect<RoleHostCreateResponse, RoleHostOperationalError> => {
        calls.push('create');
        return Effect.succeed({
          schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          sessionId: options.sessionId,
          ownershipToken: options.ownershipToken,
          generation: options.createGeneration ?? options.generation,
          sequence: options.initialSequence,
          runtimeIdentity: options.identity ?? FIXTURE_IDENTITY,
        });
      },
      submit: (
        request: RoleHostSubmitRequest,
      ): Effect.Effect<RoleHostSubmitResponse, RoleHostOperationalError> => {
        calls.push('submit');
        submitKeys.push(request.idempotencyKey);
        if (options.submitFails === true) {
          return Effect.fail(
            new RoleHostOperationalError({
              message: 'the submit side effect is unknown',
              operation: 'submit',
            }),
          );
        }
        return Effect.succeed({
          schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          submission: 'accepted',
        });
      },
      observe: (): Effect.Effect<RoleHostObserveResponse, RoleHostOperationalError> => {
        calls.push('observe');
        const index = Math.min(observeIndex, options.observeResponses.length - 1);
        observeIndex += 1;
        const response = options.observeResponses[index];
        if (response === undefined) {
          return Effect.fail(
            new RoleHostOperationalError({ message: 'no scripted response', operation: 'observe' }),
          );
        }
        return Effect.succeed(response);
      },
      stop: (): Effect.Effect<RoleHostStopResponse, RoleHostOperationalError> => {
        calls.push('stop');
        return Effect.succeed({
          schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          disposition: 'disposed',
        });
      },
    }),
  );
  return { layer, calls, submitKeys };
}

const CREATE_REQUEST: RoleHostCreateRequest = {
  schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
  runId: RUN_ID,
  role: 'coder',
  attempt: 1,
  generation: 1,
};

const SUBMIT_REQUEST: RoleHostSubmitRequest = {
  schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
  sessionId: 'session-1',
  ownershipToken: 'owner-1',
  generation: 1,
  idempotencyKey: 'key-1',
  prompt: 'Implement the requested slice.',
  deadline: '2026-09-13T00:00:00.000Z',
};

const OBSERVE_REQUEST: RoleHostObserveRequest = {
  schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
  sessionId: 'session-1',
  ownershipToken: 'owner-1',
  generation: 1,
  afterSequence: 0,
};

const STOP_REQUEST: RoleHostStopRequest = {
  schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
  sessionId: 'session-1',
  ownershipToken: 'owner-1',
  generation: 1,
};

function adapterLayer(
  scenario: string,
  logPath: string,
  maxOutputBytes = 65_536,
  environmentAllowlist: ReadonlyArray<string> = [],
): Layer.Layer<RoleHost> {
  return roleHostProcessLayer({
    command: [process.execPath, FIXTURE_PATH, scenario, logPath],
    cwd: REPOSITORY_ROOT,
    environmentAllowlist,
    timeoutMs: 10_000,
    maxOutputBytes,
  });
}

const ROLE_OCCURRED_AT = '2026-09-13T00:00:00.000Z';

function buildRoleHistory(drafts: ReadonlyArray<RunEventDraft>): ReadonlyArray<RunEvent> {
  const events: Array<RunEvent> = [];
  let previousHash: string | null = null;
  for (const [index, draft] of drafts.entries()) {
    const event: RunEvent = sealRunEvent(
      {
        schemaVersion: 1,
        runId: RUN_ID,
        revision: index + 1,
        eventId: randomUUID(),
        occurredAt: ROLE_OCCURRED_AT,
        previousEventHash: previousHash,
      },
      draft,
    );
    events.push(event);
    previousHash = event.eventHash;
  }
  return events;
}

const RUN_CREATED_DRAFT: RunEventDraft = {
  type: 'run-created',
  payload: { taskId: 'TASK-1' },
};

const SESSION_CREATED_DRAFT: RunEventDraft = {
  type: 'role-session-created',
  payload: {
    role: 'coder',
    attempt: 1,
    generation: 1,
    sessionId: 'session-1',
    ownershipToken: 'owner-1',
    sequence: 0,
    runtimeIdentity: FIXTURE_IDENTITY,
    workingDirectory: null,
  },
};

const SUBMISSION_REQUESTED_DRAFT: RunEventDraft = {
  type: 'role-session-submission-requested',
  payload: {
    sessionId: 'session-1',
    generation: 1,
    idempotencyKey: 'key-1',
    promptHash: 'a'.repeat(64),
    baselineSequence: 0,
  },
};

const SUBMISSION_STARTED_DRAFT: RunEventDraft = {
  type: 'role-session-submission-started',
  payload: {
    sessionId: 'session-1',
    generation: 1,
    idempotencyKey: 'key-1',
    submission: 'accepted',
  },
};

const SETTLED_OBSERVED_DRAFT: RunEventDraft = {
  type: 'role-session-observed',
  payload: {
    sessionId: 'session-1',
    generation: 1,
    status: 'settled',
    sequence: 1,
    eventCount: 1,
    narrative: '# Result',
    control: { schemaVersion: 1, outcome: 'implemented' },
  },
};

describe('role session history replay', () => {
  it('derives settled session state from a valid chain', () => {
    const events = buildRoleHistory([
      RUN_CREATED_DRAFT,
      SESSION_CREATED_DRAFT,
      SUBMISSION_REQUESTED_DRAFT,
      SUBMISSION_STARTED_DRAFT,
      SETTLED_OBSERVED_DRAFT,
    ]);
    const verification = verifyRunHistoryEvents(events, RUN_ID);
    expect(verification.ok).toBe(true);
    if (verification.ok) {
      const session = verification.derived.roleSessions.at(0);
      expect(session?.submissionStarted).toBe('accepted');
      expect(session?.lastObservation?.status).toBe('settled');
      expect(session?.lastObservation?.narrative).toBe('# Result');
    }
  });

  it('rejects duplicate submission intents and unknown sessions', () => {
    const duplicate = verifyRunHistoryEvents(
      buildRoleHistory([
        RUN_CREATED_DRAFT,
        SESSION_CREATED_DRAFT,
        SUBMISSION_REQUESTED_DRAFT,
        SUBMISSION_REQUESTED_DRAFT,
      ]),
      RUN_ID,
    );
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.problem).toContain('second submission intent');
    }

    const unknown = verifyRunHistoryEvents(
      buildRoleHistory([
        RUN_CREATED_DRAFT,
        {
          type: 'role-session-stopped',
          payload: { sessionId: 'session-unknown', generation: 1, disposition: 'disposed' },
        },
      ]),
      RUN_ID,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.problem).toContain('unknown session');
    }
  });

  it('rejects a settled observation without a narrative and a regressed sequence', () => {
    const missingNarrative = verifyRunHistoryEvents(
      buildRoleHistory([
        RUN_CREATED_DRAFT,
        SESSION_CREATED_DRAFT,
        {
          type: 'role-session-observed',
          payload: {
            sessionId: 'session-1',
            generation: 1,
            status: 'settled',
            sequence: 1,
            eventCount: 0,
            narrative: null,
            control: null,
          },
        },
      ]),
      RUN_ID,
    );
    expect(missingNarrative.ok).toBe(false);
    if (!missingNarrative.ok) {
      expect(missingNarrative.problem).toContain('without a narrative');
    }

    const regressed = verifyRunHistoryEvents(
      buildRoleHistory([
        RUN_CREATED_DRAFT,
        SESSION_CREATED_DRAFT,
        {
          type: 'role-session-observed',
          payload: {
            sessionId: 'session-1',
            generation: 1,
            status: 'active',
            sequence: 5,
            eventCount: 0,
            narrative: null,
            control: null,
          },
        },
        {
          type: 'role-session-observed',
          payload: {
            sessionId: 'session-1',
            generation: 1,
            status: 'active',
            sequence: 3,
            eventCount: 0,
            narrative: null,
            control: null,
          },
        },
      ]),
      RUN_ID,
    );
    expect(regressed.ok).toBe(false);
    if (!regressed.ok) {
      expect(regressed.problem).toContain('regresses');
    }
  });
});

describe('role-host closed documents', () => {
  it('accepts a complete create request and rejects unknown or invalid fields', () => {
    expect(
      Schema.decodeUnknownSync(RoleHostCreateRequestSchema, PARSE_OPTIONS)(CREATE_REQUEST),
    ).toMatchObject(CREATE_REQUEST);
    for (const invalid of [
      { ...CREATE_REQUEST, extra: true },
      { ...CREATE_REQUEST, role: 'unknown-role' },
      { ...CREATE_REQUEST, attempt: 0 },
      { ...CREATE_REQUEST, generation: -1 },
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(RoleHostCreateRequestSchema, PARSE_OPTIONS)(invalid),
      ).toThrow();
    }
  });

  it('requires narrative and control only for settled observations', () => {
    expect(
      Schema.decodeUnknownSync(RoleHostObserveResponseSchema, PARSE_OPTIONS)(ACTIVE_RESPONSE),
    ).toMatchObject({ status: 'active' });
    expect(
      Schema.decodeUnknownSync(RoleHostObserveResponseSchema, PARSE_OPTIONS)(SETTLED_RESPONSE),
    ).toMatchObject({ status: 'settled' });
    for (const invalid of [
      { ...ACTIVE_RESPONSE, narrative: 'unexpected' },
      { ...SETTLED_RESPONSE, control: 'not-an-object' },
      { ...SETTLED_RESPONSE, control: null },
      { ...SETTLED_RESPONSE, narrative: '' },
      { ...SETTLED_RESPONSE, sequence: -1 },
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(RoleHostObserveResponseSchema, PARSE_OPTIONS)(invalid),
      ).toThrow();
    }
  });

  it('closes submit and stop responses', () => {
    expect(
      Schema.decodeUnknownSync(
        RoleHostSubmitResponseSchema,
        PARSE_OPTIONS,
      )({
        schemaVersion: 1,
        submission: 'accepted',
      }),
    ).toEqual({ schemaVersion: 1, submission: 'accepted' });
    expect(
      Schema.decodeUnknownSync(
        RoleHostStopResponseSchema,
        PARSE_OPTIONS,
      )({
        schemaVersion: 1,
        disposition: 'already_disposed',
      }),
    ).toEqual({ schemaVersion: 1, disposition: 'already_disposed' });
    expect(() =>
      Schema.decodeUnknownSync(
        RoleHostSubmitResponseSchema,
        PARSE_OPTIONS,
      )({
        schemaVersion: 1,
        submission: 'unknown',
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(
        RoleHostStopResponseSchema,
        PARSE_OPTIONS,
      )({
        schemaVersion: 1,
        disposition: 'disposed',
        extra: true,
      }),
    ).toThrow();
  });
});

describe('role-host process adapter', () => {
  it.effect('launches the host directly for every closed operation', () =>
    Effect.gen(function* () {
      const log = setupLog();
      try {
        const outcome = yield* Effect.gen(function* () {
          const host = yield* RoleHost;
          const created = yield* host.create(CREATE_REQUEST);
          const submitted = yield* host.submit(SUBMIT_REQUEST);
          const observed = yield* host.observe(OBSERVE_REQUEST);
          const stopped = yield* host.stop(STOP_REQUEST);
          return { created, submitted, observed, stopped };
        }).pipe(Effect.provide(adapterLayer('settled', log.logPath)));

        expect(outcome.created.sessionId).toBe('session-1');
        expect(outcome.created.runtimeIdentity).toEqual(FIXTURE_IDENTITY);
        expect(outcome.submitted.submission).toBe('accepted');
        expect(outcome.observed.status).toBe('settled');
        expect(outcome.stopped.disposition).toBe('disposed');

        const invocations = readInvocations(log.logPath);
        expect(invocations.map((invocation) => invocation.operation)).toEqual([
          'create',
          'submit',
          'observe',
          'stop',
        ]);
        for (const invocation of invocations) {
          expect(invocation.argv.at(-1)).toBe(invocation.operation);
          expect(invocation.argv.at(2)).toBe('settled');
          expect(invocation.argv.at(1)).toBe(FIXTURE_PATH);
        }
      } finally {
        log.cleanup();
      }
    }),
  );

  it.effect('is idempotent for the same session, generation, and idempotency key', () =>
    Effect.gen(function* () {
      const log = setupLog();
      try {
        const submissions = yield* Effect.gen(function* () {
          const host = yield* RoleHost;
          const first = yield* host.submit(SUBMIT_REQUEST);
          const second = yield* host.submit(SUBMIT_REQUEST);
          return { first, second };
        }).pipe(Effect.provide(adapterLayer('idempotent-submit', log.logPath)));

        expect(submissions.first.submission).toBe('accepted');
        expect(submissions.second.submission).toBe('already_accepted');
        expect(readInvocations(log.logPath)).toHaveLength(2);
      } finally {
        log.cleanup();
      }
    }),
  );

  it.effect('forwards only configured environment names', () =>
    Effect.gen(function* () {
      const log = setupLog();
      process.env.FOUNDRY_FAKE_TOKEN = 'forwarded-secret';
      process.env.FOUNDRY_FAKE_UNLISTED = 'must-not-leak';
      try {
        yield* Effect.gen(function* () {
          const host = yield* RoleHost;
          yield* host.create(CREATE_REQUEST);
        }).pipe(
          Effect.provide(adapterLayer('settled', log.logPath, 65_536, ['FOUNDRY_FAKE_TOKEN'])),
        );

        const invocation = readInvocations(log.logPath).at(0);
        expect(invocation?.env.FOUNDRY_FAKE_TOKEN).toBe('forwarded-secret');
        expect(invocation?.env.FOUNDRY_FAKE_UNLISTED).toBeNull();
      } finally {
        delete process.env.FOUNDRY_FAKE_TOKEN;
        delete process.env.FOUNDRY_FAKE_UNLISTED;
        log.cleanup();
      }
    }),
  );

  it.effect('fails operationally on nonzero, malformed, extra, or oversized output', () =>
    Effect.gen(function* () {
      for (const scenario of ['nonzero', 'malformed', 'extra']) {
        const log = setupLog();
        try {
          const error = yield* Effect.gen(function* () {
            const host = yield* RoleHost;
            yield* host.observe(OBSERVE_REQUEST);
          }).pipe(Effect.provide(adapterLayer(scenario, log.logPath)), Effect.flip);
          expect(error).toBeInstanceOf(RoleHostOperationalError);
        } finally {
          log.cleanup();
        }
      }

      const oversizeLog = setupLog();
      try {
        const error = yield* Effect.gen(function* () {
          const host = yield* RoleHost;
          yield* host.observe(OBSERVE_REQUEST);
        }).pipe(Effect.provide(adapterLayer('oversized', oversizeLog.logPath, 512)), Effect.flip);
        expect(error).toBeInstanceOf(RoleHostOperationalError);
      } finally {
        oversizeLog.cleanup();
      }
    }),
  );

  it.effect('rejects a settled response with malformed control', () =>
    Effect.gen(function* () {
      const log = setupLog();
      try {
        const error = yield* Effect.gen(function* () {
          const host = yield* RoleHost;
          yield* host.observe(OBSERVE_REQUEST);
        }).pipe(Effect.provide(adapterLayer('bad-control', log.logPath)), Effect.flip);
        expect(error).toBeInstanceOf(RoleHostOperationalError);
      } finally {
        log.cleanup();
      }
    }),
  );
});

describe('role conversation lifecycle', () => {
  it.effect('creates, submits once, and returns a settled turn', () =>
    Effect.gen(function* () {
      const run = setupRun();
      try {
        yield* seedRunCreated(run.runDirectory);
        const fake = fakeRoleHost({
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: 1,
          initialSequence: 0,
          observeResponses: [SETTLED_RESPONSE],
        });
        const result = yield* startOrResumeRoleTurn(baseTurnOptions(run.runDirectory)).pipe(
          Effect.provide(Layer.mergeAll(RunHistoryLive, fake.layer)),
        );

        expect(result.outcome).toBe('settled');
        expect(result.narrative).toBe(SETTLED_RESPONSE.narrative);
        expect(fake.calls).toEqual(['create', 'submit', 'observe']);

        const session = yield* readRecordedSession(run.runDirectory);
        expect(session?.runtimeIdentity).toEqual(FIXTURE_IDENTITY);
        expect(session?.submissionStarted).toBe('accepted');
        expect(session?.lastObservation?.status).toBe('settled');
      } finally {
        run.cleanup();
      }
    }),
  );

  it.effect('records the host-selected runtime identity unchanged', () =>
    Effect.gen(function* () {
      const run = setupRun();
      try {
        yield* seedRunCreated(run.runDirectory);
        const identity = {
          adapterVersion: 'host-b',
          provider: 'host-b-provider',
          model: 'host-b-model',
          toolProfile: 'host-b-profile',
        } as const;
        const fake = fakeRoleHost({
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: 1,
          initialSequence: 0,
          observeResponses: [SETTLED_RESPONSE],
          identity,
        });
        const result = yield* startOrResumeRoleTurn(baseTurnOptions(run.runDirectory)).pipe(
          Effect.provide(Layer.mergeAll(RunHistoryLive, fake.layer)),
        );

        expect(result.outcome).toBe('settled');
        expect(result.sequence).toBe(SETTLED_RESPONSE.sequence);
        const session = yield* readRecordedSession(run.runDirectory);
        expect(session?.runtimeIdentity).toEqual(identity);
        expect(session?.runtimeIdentity).not.toEqual(FIXTURE_IDENTITY);
        expect(fake.calls).toEqual(['create', 'submit', 'observe']);
      } finally {
        run.cleanup();
      }
    }),
  );

  it.effect('polls an active turn until it settles without resubmitting', () =>
    Effect.gen(function* () {
      const run = setupRun();
      try {
        yield* seedRunCreated(run.runDirectory);
        const fake = fakeRoleHost({
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: 1,
          initialSequence: 0,
          observeResponses: [ACTIVE_RESPONSE, SETTLED_RESPONSE],
        });
        const result = yield* startOrResumeRoleTurn(baseTurnOptions(run.runDirectory)).pipe(
          Effect.provide(Layer.mergeAll(RunHistoryLive, fake.layer)),
        );

        expect(result.sequence).toBe(2);
        expect(fake.calls).toEqual(['create', 'submit', 'observe', 'observe']);
        expect(fake.calls.filter((call) => call === 'submit')).toHaveLength(1);
      } finally {
        run.cleanup();
      }
    }),
  );

  it.effect('observes the recorded session instead of resubmitting after submission began', () =>
    Effect.gen(function* () {
      const run = setupRun();
      try {
        yield* seedRunCreated(run.runDirectory);
        const fake = fakeRoleHost({
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: 1,
          initialSequence: 0,
          observeResponses: [SETTLED_RESPONSE],
          submitFails: true,
        });
        const firstError = yield* startOrResumeRoleTurn(baseTurnOptions(run.runDirectory)).pipe(
          Effect.provide(Layer.mergeAll(RunHistoryLive, fake.layer)),
          Effect.flip,
        );
        expect(firstError).toBeInstanceOf(RoleConversationError);
        if (firstError instanceof RoleConversationError) {
          expect(firstError.reason).toBe('ambiguous-submission');
        }

        const recovered = yield* startOrResumeRoleTurn(baseTurnOptions(run.runDirectory)).pipe(
          Effect.provide(Layer.mergeAll(RunHistoryLive, fake.layer)),
        );
        expect(recovered.outcome).toBe('settled');
        expect(fake.calls).toEqual(['create', 'submit', 'observe']);
        expect(fake.calls.filter((call) => call === 'submit')).toHaveLength(1);
        expect(fake.submitKeys).toHaveLength(1);
      } finally {
        run.cleanup();
      }
    }),
  );

  it.effect('never starts a second turn or host call for an already settled session', () =>
    Effect.gen(function* () {
      const run = setupRun();
      try {
        yield* seedRunCreated(run.runDirectory);
        const fake = fakeRoleHost({
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: 1,
          initialSequence: 0,
          observeResponses: [SETTLED_RESPONSE],
        });
        const live = Layer.mergeAll(RunHistoryLive, fake.layer);
        yield* startOrResumeRoleTurn(baseTurnOptions(run.runDirectory)).pipe(Effect.provide(live));
        const callsAfterFirst = [...fake.calls];
        const second = yield* startOrResumeRoleTurn(baseTurnOptions(run.runDirectory)).pipe(
          Effect.provide(live),
        );

        expect(second.outcome).toBe('settled');
        expect(fake.calls).toEqual(callsAfterFirst);
        expect(fake.submitKeys).toHaveLength(1);
      } finally {
        run.cleanup();
      }
    }),
  );

  it.effect('treats a lost session as an operational failure', () =>
    Effect.gen(function* () {
      const run = setupRun();
      try {
        yield* seedRunCreated(run.runDirectory);
        const fake = fakeRoleHost({
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: 1,
          initialSequence: 0,
          observeResponses: [LOST_RESPONSE],
        });
        const error = yield* startOrResumeRoleTurn(baseTurnOptions(run.runDirectory)).pipe(
          Effect.provide(Layer.mergeAll(RunHistoryLive, fake.layer)),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(RoleConversationError);
        if (error instanceof RoleConversationError) {
          expect(error.reason).toBe('lost-session');
        }
        const session = yield* readRecordedSession(run.runDirectory);
        expect(session?.lastObservation?.status).toBe('lost');
      } finally {
        run.cleanup();
      }
    }),
  );

  it.effect('rejects a sequence regression and an empty settled narrative', () =>
    Effect.gen(function* () {
      const regressionRun = setupRun();
      try {
        yield* seedRunCreated(regressionRun.runDirectory);
        const regressionFake = fakeRoleHost({
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: 1,
          initialSequence: 5,
          observeResponses: [{ schemaVersion: 1, status: 'active', sequence: 3, events: [] }],
        });
        const regressionError = yield* startOrResumeRoleTurn(
          baseTurnOptions(regressionRun.runDirectory),
        ).pipe(Effect.provide(Layer.mergeAll(RunHistoryLive, regressionFake.layer)), Effect.flip);
        expect(regressionError).toBeInstanceOf(RoleConversationError);
        if (regressionError instanceof RoleConversationError) {
          expect(regressionError.reason).toBe('sequence-regression');
        }
      } finally {
        regressionRun.cleanup();
      }

      const emptyRun = setupRun();
      try {
        yield* seedRunCreated(emptyRun.runDirectory);
        const emptyFake = fakeRoleHost({
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: 1,
          initialSequence: 0,
          observeResponses: [
            {
              schemaVersion: 1,
              status: 'settled',
              sequence: 1,
              events: [],
              narrative: '   ',
              control: {},
            },
          ],
        });
        const emptyError = yield* startOrResumeRoleTurn(
          baseTurnOptions(emptyRun.runDirectory),
        ).pipe(Effect.provide(Layer.mergeAll(RunHistoryLive, emptyFake.layer)), Effect.flip);
        expect(emptyError).toBeInstanceOf(RoleConversationError);
        if (emptyError instanceof RoleConversationError) {
          expect(emptyError.reason).toBe('empty-narrative');
        }
      } finally {
        emptyRun.cleanup();
      }
    }),
  );

  it.effect('reports a create generation mismatch as an operational failure', () =>
    Effect.gen(function* () {
      const run = setupRun();
      try {
        yield* seedRunCreated(run.runDirectory);
        const fake = fakeRoleHost({
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: 1,
          createGeneration: 99,
          initialSequence: 0,
          observeResponses: [SETTLED_RESPONSE],
        });
        const error = yield* startOrResumeRoleTurn(baseTurnOptions(run.runDirectory)).pipe(
          Effect.provide(Layer.mergeAll(RunHistoryLive, fake.layer)),
          Effect.flip,
        );
        expect(error).toBeInstanceOf(RoleConversationError);
        if (error instanceof RoleConversationError) {
          expect(error.reason).toBe('session-mismatch');
        }
        expect(fake.calls).toEqual(['create']);
      } finally {
        run.cleanup();
      }
    }),
  );

  it.effect('bounds an unsettled turn by the configured deadline', () =>
    Effect.gen(function* () {
      const run = setupRun();
      try {
        yield* seedRunCreated(run.runDirectory);
        const fake = fakeRoleHost({
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: 1,
          initialSequence: 0,
          observeResponses: [
            {
              schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
              status: 'active',
              sequence: 1,
              events: [],
            },
          ],
        });
        const fiber = yield* Effect.forkScoped(
          startOrResumeRoleTurn({
            ...baseTurnOptions(run.runDirectory),
            pollMs: 1_000,
            turnTimeoutMs: 5_000,
          }).pipe(Effect.provide(Layer.mergeAll(RunHistoryLive, fake.layer))),
        );
        yield* TestClock.adjust(Duration.millis(60_000));
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);
        expect(error).toBeInstanceOf(RoleConversationError);
        if (error instanceof RoleConversationError) {
          expect(error.reason).toBe('turn-timeout');
        }
      } finally {
        run.cleanup();
      }
    }),
  );

  it.effect('stops the exact owned session and is idempotent', () =>
    Effect.gen(function* () {
      const run = setupRun();
      try {
        yield* seedRunCreated(run.runDirectory);
        const fake = fakeRoleHost({
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: 1,
          initialSequence: 0,
          observeResponses: [SETTLED_RESPONSE],
        });
        const live = Layer.mergeAll(RunHistoryLive, fake.layer);
        yield* startOrResumeRoleTurn(baseTurnOptions(run.runDirectory)).pipe(Effect.provide(live));
        const first = yield* stopRoleSession({
          runDirectory: run.runDirectory,
          runId: RUN_ID,
          role: 'coder',
          attempt: 1,
          generation: 1,
        }).pipe(Effect.provide(live));
        const second = yield* stopRoleSession({
          runDirectory: run.runDirectory,
          runId: RUN_ID,
          role: 'coder',
          attempt: 1,
          generation: 1,
        }).pipe(Effect.provide(live));

        expect(first.disposition).toBe('disposed');
        expect(second.disposition).toBe('disposed');
        expect(fake.calls.filter((call) => call === 'stop')).toHaveLength(1);
        const session = yield* readRecordedSession(run.runDirectory);
        expect(session?.stopDisposition).toBe('disposed');
      } finally {
        run.cleanup();
      }
    }),
  );

  it.effect('fails a stop for an unknown session', () =>
    Effect.gen(function* () {
      const run = setupRun();
      try {
        yield* seedRunCreated(run.runDirectory);
        const fake = fakeRoleHost({
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: 1,
          initialSequence: 0,
          observeResponses: [SETTLED_RESPONSE],
        });
        const error = yield* stopRoleSession({
          runDirectory: run.runDirectory,
          runId: RUN_ID,
          role: 'coder',
          attempt: 1,
          generation: 1,
        }).pipe(Effect.provide(Layer.mergeAll(RunHistoryLive, fake.layer)), Effect.flip);
        expect(error).toBeInstanceOf(RoleConversationError);
        if (error instanceof RoleConversationError) {
          expect(error.reason).toBe('session-missing');
        }
        expect(fake.calls).toEqual([]);
      } finally {
        run.cleanup();
      }
    }),
  );
});
