import { Context, Duration, Effect, Schema } from 'effect';
import { createHash, randomUUID } from 'node:crypto';

import { ROLE_HOST_PROTOCOL_VERSION, roleHostEventsAreOrdered } from '../../domain/role-host.js';
import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';

import type { RunHistoryStorage } from '../run-history/index.js';
import type { RunHistoryError } from '../run-history/index.js';
import type {
  RoleHostControl,
  RoleHostCreateRequest,
  RoleHostCreateResponse,
  RoleHostDisposition,
  RoleHostObserveRequest,
  RoleHostObserveResponse,
  RoleHostRole,
  RoleHostSessionState,
  RoleHostStopRequest,
  RoleHostStopResponse,
  RoleHostSubmitRequest,
  RoleHostSubmitResponse,
} from '../../domain/role-host.js';

export class RoleHostOperationalError extends Schema.TaggedError<RoleHostOperationalError>()(
  'RoleHostOperationalError',
  {
    message: Schema.String,
    operation: Schema.Literals(['create', 'submit', 'observe', 'stop']),
  },
) {}

export const ROLE_CONVERSATION_FAILURE_REASONS = [
  'session-missing',
  'session-mismatch',
  'lost-session',
  'sequence-regression',
  'empty-narrative',
  'ambiguous-submission',
  'turn-timeout',
] as const;

export type RoleConversationFailureReason = (typeof ROLE_CONVERSATION_FAILURE_REASONS)[number];

export class RoleConversationError extends Schema.TaggedError<RoleConversationError>()(
  'RoleConversationError',
  {
    message: Schema.String,
    reason: Schema.Literals(ROLE_CONVERSATION_FAILURE_REASONS),
    runId: Schema.String,
  },
) {}

export class RoleHost extends Context.Service<
  RoleHost,
  {
    readonly create: (
      request: RoleHostCreateRequest,
    ) => Effect.Effect<RoleHostCreateResponse, RoleHostOperationalError>;
    readonly submit: (
      request: RoleHostSubmitRequest,
    ) => Effect.Effect<RoleHostSubmitResponse, RoleHostOperationalError>;
    readonly observe: (
      request: RoleHostObserveRequest,
    ) => Effect.Effect<RoleHostObserveResponse, RoleHostOperationalError>;
    readonly stop: (
      request: RoleHostStopRequest,
    ) => Effect.Effect<RoleHostStopResponse, RoleHostOperationalError>;
  }
>()('foundry/application/role-conversations/Host') {}

export interface RoleTurnTarget {
  readonly runDirectory: string;
  readonly runId: string;
  readonly role: RoleHostRole;
  readonly attempt: number;
  readonly generation: number;
}

export interface StartOrResumeRoleTurnOptions extends RoleTurnTarget {
  readonly prompt: string;
  readonly deadline: string;
  readonly pollMs: number;
  readonly turnTimeoutMs: number;
  readonly workingDirectory?: string;
  readonly readRoots?: ReadonlyArray<string>;
  readonly writeRoots?: ReadonlyArray<string>;
  readonly networkAllowlist?: ReadonlyArray<string>;
}

export type StopRoleSessionOptions = RoleTurnTarget;

export interface SettledRoleTurnResult {
  readonly outcome: 'settled';
  readonly session: RoleHostSessionState;
  readonly sequence: number;
  readonly narrative: string;
  readonly control: RoleHostControl;
}

export interface RoleSessionStopResult {
  readonly disposition: RoleHostDisposition;
  readonly session: RoleHostSessionState;
}

function findRoleSession(
  sessions: ReadonlyArray<RoleHostSessionState>,
  role: RoleHostRole,
  attempt: number,
): RoleHostSessionState | null {
  for (const session of sessions) {
    if (session.role === role && session.attempt === attempt) {
      return session;
    }
  }
  return null;
}

function conversationFailure(
  runId: string,
  reason: RoleConversationFailureReason,
  message: string,
): RoleConversationError {
  return new RoleConversationError({ message, reason, runId });
}

function settledTurnOf(session: RoleHostSessionState): SettledRoleTurnResult | null {
  const observation = session.lastObservation;
  if (observation === null || observation.status !== 'settled') {
    return null;
  }
  if (observation.narrative === null || observation.control === null) {
    return null;
  }
  return {
    outcome: 'settled',
    session,
    sequence: observation.sequence,
    narrative: observation.narrative,
    control: observation.control,
  };
}

const readRoleHistory = Effect.fn('readRoleHistory')(function* (
  options: RoleTurnTarget,
): Effect.fn.Return<
  { readonly roleSessions: ReadonlyArray<RoleHostSessionState> },
  RunHistoryError,
  RunHistoryStorage
> {
  const history = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  return { roleSessions: history.derived.roleSessions };
});

const requireRoleSession = Effect.fn('requireRoleSession')(function* (
  options: RoleTurnTarget,
): Effect.fn.Return<
  RoleHostSessionState,
  RoleConversationError | RunHistoryError,
  RunHistoryStorage
> {
  const history = yield* readRoleHistory(options);
  const session = findRoleSession(history.roleSessions, options.role, options.attempt);
  if (session === null) {
    return yield* conversationFailure(
      options.runId,
      'session-missing',
      `No role session is recorded for role "${options.role}" attempt ${options.attempt}.`,
    );
  }
  if (session.generation !== options.generation) {
    return yield* conversationFailure(
      options.runId,
      'session-mismatch',
      `The recorded role session generation ${session.generation} does not match the requested generation ${options.generation}.`,
    );
  }
  return session;
});

const observeUntilSettled = Effect.fn('observeUntilSettled')(function* (
  options: StartOrResumeRoleTurnOptions,
  initial: RoleHostSessionState,
): Effect.fn.Return<
  SettledRoleTurnResult,
  RoleConversationError | RoleHostOperationalError | RunHistoryError,
  RoleHost | RunHistoryStorage
> {
  const host = yield* RoleHost;
  let session = initial;
  let lastSequence =
    session.lastObservation?.sequence ??
    session.submission?.baselineSequence ??
    session.initialSequence;

  while (true) {
    const response = yield* host.observe({
      schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
      sessionId: session.sessionId,
      ownershipToken: session.ownershipToken,
      generation: session.generation,
      afterSequence: lastSequence,
    });
    if (response.sequence < lastSequence) {
      return yield* conversationFailure(
        options.runId,
        'sequence-regression',
        `The role host reported sequence ${response.sequence} after the recorded sequence ${lastSequence}.`,
      );
    }
    const orderProblem = roleHostEventsAreOrdered(lastSequence, response.events);
    if (orderProblem !== null) {
      return yield* conversationFailure(options.runId, 'sequence-regression', orderProblem);
    }
    if (response.status === 'settled') {
      if (response.sequence <= lastSequence) {
        return yield* conversationFailure(
          options.runId,
          'sequence-regression',
          'A settled role turn did not advance the recorded session sequence.',
        );
      }
      if (response.narrative.trim().length === 0) {
        return yield* conversationFailure(
          options.runId,
          'empty-narrative',
          'A settled role turn returned an empty narrative.',
        );
      }
      yield* appendRunEvent({
        runDirectory: options.runDirectory,
        runId: options.runId,
        createIfMissing: false,
        build: () =>
          Effect.succeed({
            type: 'role-session-observed',
            payload: {
              sessionId: session.sessionId,
              generation: session.generation,
              status: 'settled',
              sequence: response.sequence,
              eventCount: response.events.length,
              narrative: response.narrative,
              control: response.control,
            },
          } as const),
      });
      const observation = {
        status: 'settled',
        sequence: response.sequence,
        eventCount: response.events.length,
        narrative: response.narrative,
        control: response.control,
      } as const;
      const settledSession: RoleHostSessionState = {
        ...session,
        lastObservation: observation,
      };
      return {
        outcome: 'settled',
        session: settledSession,
        sequence: response.sequence,
        narrative: response.narrative,
        control: response.control,
      };
    }
    if (response.status === 'lost') {
      yield* appendRunEvent({
        runDirectory: options.runDirectory,
        runId: options.runId,
        createIfMissing: false,
        build: () =>
          Effect.succeed({
            type: 'role-session-observed',
            payload: {
              sessionId: session.sessionId,
              generation: session.generation,
              status: 'lost',
              sequence: response.sequence,
              eventCount: response.events.length,
              narrative: null,
              control: null,
            },
          } as const),
      });
      return yield* conversationFailure(
        options.runId,
        'lost-session',
        `The role host lost the owned session "${session.sessionId}".`,
      );
    }
    if (response.sequence > lastSequence) {
      yield* appendRunEvent({
        runDirectory: options.runDirectory,
        runId: options.runId,
        createIfMissing: false,
        build: () =>
          Effect.succeed({
            type: 'role-session-observed',
            payload: {
              sessionId: session.sessionId,
              generation: session.generation,
              status: 'active',
              sequence: response.sequence,
              eventCount: response.events.length,
              narrative: null,
              control: null,
            },
          } as const),
      });
      session = {
        ...session,
        lastObservation: {
          status: 'active',
          sequence: response.sequence,
          eventCount: response.events.length,
          narrative: null,
          control: null,
        },
      };
    }
    lastSequence = Math.max(lastSequence, response.sequence);
    if (options.pollMs > 0) {
      yield* Effect.sleep(Duration.millis(options.pollMs));
    }
  }
});

export const startOrResumeRoleTurn = Effect.fn('startOrResumeRoleTurn')(function* (
  options: StartOrResumeRoleTurnOptions,
): Effect.fn.Return<
  SettledRoleTurnResult,
  RoleConversationError | RoleHostOperationalError | RunHistoryError,
  RoleHost | RunHistoryStorage
> {
  const host = yield* RoleHost;
  const history = yield* readRoleHistory(options);
  const existing = findRoleSession(history.roleSessions, options.role, options.attempt);

  let session: RoleHostSessionState;
  if (existing === null) {
    const created = yield* host.create({
      schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
      runId: options.runId,
      role: options.role,
      attempt: options.attempt,
      generation: options.generation,
      workingDirectory: options.workingDirectory,
      readRoots: options.readRoots,
      writeRoots: options.writeRoots,
      networkAllowlist: options.networkAllowlist,
    });
    if (created.generation !== options.generation) {
      return yield* conversationFailure(
        options.runId,
        'session-mismatch',
        `The role host created a session for generation ${created.generation} instead of ${options.generation}.`,
      );
    }
    yield* appendRunEvent({
      runDirectory: options.runDirectory,
      runId: options.runId,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'role-session-created',
          payload: {
            role: options.role,
            attempt: options.attempt,
            generation: options.generation,
            sessionId: created.sessionId,
            ownershipToken: created.ownershipToken,
            sequence: created.sequence,
            runtimeIdentity: created.runtimeIdentity,
            workingDirectory: options.workingDirectory ?? null,
          },
        } as const),
    });
    session = yield* requireRoleSession(options);
  } else {
    if (existing.generation !== options.generation) {
      return yield* conversationFailure(
        options.runId,
        'session-mismatch',
        `The recorded role session generation ${existing.generation} does not match the requested generation ${options.generation}.`,
      );
    }
    session = existing;
  }

  const alreadySettled = settledTurnOf(session);
  if (alreadySettled !== null) {
    return alreadySettled;
  }
  if (session.lastObservation?.status === 'lost') {
    return yield* conversationFailure(
      options.runId,
      'lost-session',
      `The recorded role session "${session.sessionId}" was lost and cannot resume.`,
    );
  }

  if (session.submission === null) {
    const idempotencyKey = randomUUID();
    const promptHash = createHash('sha256').update(options.prompt, 'utf8').digest('hex');
    const baselineSequence = session.lastObservation?.sequence ?? session.initialSequence;
    yield* appendRunEvent({
      runDirectory: options.runDirectory,
      runId: options.runId,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'role-session-submission-requested',
          payload: {
            sessionId: session.sessionId,
            generation: session.generation,
            idempotencyKey,
            promptHash,
            baselineSequence,
          },
        } as const),
    });
    const submitted = yield* requireRoleSession(options);
    const submission = submitted.submission;
    if (submission === null) {
      return yield* conversationFailure(
        options.runId,
        'session-missing',
        `The recorded submission intent for session "${submitted.sessionId}" is unavailable.`,
      );
    }
    session = submitted;
    const response = yield* host
      .submit({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        sessionId: session.sessionId,
        ownershipToken: session.ownershipToken,
        generation: session.generation,
        idempotencyKey: submission.idempotencyKey,
        prompt: options.prompt,
        deadline: options.deadline,
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new RoleConversationError({
              message: `The role submission for session "${session.sessionId}" may have been accepted and cannot be repeated safely: ${error.message}`,
              reason: 'ambiguous-submission',
              runId: options.runId,
            }),
        ),
      );
    yield* appendRunEvent({
      runDirectory: options.runDirectory,
      runId: options.runId,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'role-session-submission-started',
          payload: {
            sessionId: session.sessionId,
            generation: session.generation,
            idempotencyKey: submission.idempotencyKey,
            submission: response.submission,
          },
        } as const),
    });
  }

  return yield* observeUntilSettled(options, session).pipe(
    Effect.timeout(Duration.millis(options.turnTimeoutMs)),
    Effect.catchTag(
      'TimeoutError',
      () =>
        new RoleConversationError({
          message: `The role turn for session "${session.sessionId}" did not settle within ${options.turnTimeoutMs}ms.`,
          reason: 'turn-timeout',
          runId: options.runId,
        }),
    ),
  );
});

export const stopRoleSession = Effect.fn('stopRoleSession')(function* (
  options: StopRoleSessionOptions,
): Effect.fn.Return<
  RoleSessionStopResult,
  RoleConversationError | RoleHostOperationalError | RunHistoryError,
  RoleHost | RunHistoryStorage
> {
  const host = yield* RoleHost;
  const session = yield* requireRoleSession(options);
  if (session.stopDisposition !== null) {
    return { disposition: session.stopDisposition, session };
  }
  const response = yield* host.stop({
    schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
    sessionId: session.sessionId,
    ownershipToken: session.ownershipToken,
    generation: session.generation,
  });
  yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'role-session-stopped',
        payload: {
          sessionId: session.sessionId,
          generation: session.generation,
          disposition: response.disposition,
        },
      } as const),
  });
  return {
    disposition: response.disposition,
    session: { ...session, stopDisposition: response.disposition },
  };
});
