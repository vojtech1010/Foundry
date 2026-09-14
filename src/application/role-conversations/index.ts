import { Context, Duration, Effect, Schema } from 'effect';
import { createHash, randomUUID } from 'node:crypto';

import type { Layer } from 'effect';

import {
  BUNDLED_ROLE_HOST_CAPABILITIES,
  ROLE_HOST_OPERATIONS,
  ROLE_HOST_PROTOCOL_VERSION,
  ROLE_HOST_ROLES,
  evaluateRoleHostCapabilities,
  resolveRoleHostRoute,
  roleHostEventsAreOrdered,
} from '../../domain/role-host.js';
import { deriveRoleHostAccessScope } from '../../domain/role-permissions.js';
import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';

import type { RunHistoryStorage } from '../run-history/index.js';
import type { RunHistoryError } from '../run-history/index.js';
import type { RoleControlRepairRecord } from '../../domain/run-history.js';
import type {
  RoleHostCapabilitiesRequest,
  RoleHostCapabilitiesResponse,
  RoleHostCapabilityProblemKind,
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
import { BUNDLED_CREDENTIAL_ENVIRONMENT_NAMES } from '../../domain/project-configuration.js';
import type { ProjectConfiguration, RoleHarnessName } from '../../domain/project-configuration.js';
import type { RoleTurnLocations } from '../../domain/role-permissions.js';

export class RoleHostOperationalError extends Schema.TaggedError<RoleHostOperationalError>()(
  'RoleHostOperationalError',
  {
    message: Schema.String,
    operation: Schema.Literals(ROLE_HOST_OPERATIONS),
  },
) {}

export const ROLE_CONVERSATION_FAILURE_REASONS = [
  'session-missing',
  'session-mismatch',
  'lost-session',
  'sequence-regression',
  'empty-narrative',
  'narrative-changed',
  'ambiguous-submission',
  'turn-timeout',
  'permission-profile-unavailable',
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
    readonly capabilities: (
      request: RoleHostCapabilitiesRequest,
    ) => Effect.Effect<RoleHostCapabilitiesResponse, RoleHostOperationalError>;
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

export interface RoleHostLaunchOptions {
  /**
   * Per-role routing: the harness to launch for the role. The adapter
   * resolves its hardcoded catalog argv for that harness and validates the
   * model against the harness catalog, failing closed on unknown models.
   * Launch details are never carried in configuration.
   */
  readonly harness: RoleHarnessName;
  /** The model the harness must serve. */
  readonly model: string;
  readonly cwd: string;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export class RoleHostLauncher extends Context.Service<
  RoleHostLauncher,
  {
    readonly launch: (options: RoleHostLaunchOptions) => Layer.Layer<RoleHost>;
  }
>()('foundry/application/role-conversations/Launcher') {}

/**
 * Resolves bundled harness executables and models without spawning anything.
 * The platform implementation searches the process PATH for the hardcoded
 * per-harness, per-platform executable candidates and checks model catalog
 * membership. Doctor verification consumes this; live runs resolve through
 * the spawning adapter instead.
 */
export class RoleHostBinaryResolver extends Context.Service<
  RoleHostBinaryResolver,
  {
    readonly resolveExecutable: (
      harness: RoleHarnessName,
    ) => Effect.Effect<string, RoleHostCapabilityError>;
    readonly resolveModel: (
      harness: RoleHarnessName,
      model: string,
    ) => Effect.Effect<string, RoleHostCapabilityError>;
  }
>()('foundry/application/role-conversations/BinaryResolver') {}

export interface RoleHostRouteLaunchOptions {
  readonly configuration: ProjectConfiguration;
  readonly role: RoleHostRole;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

/**
 * Builds launch options for one role from the configuration's per-role
 * harness and model selection. The returned options carry the exact
 * configured `harness` and `model` with provider credential names from the
 * hardcoded bundled set, so the adapter resolves its catalog argv and
 * validates the model. Timeouts and output bounds default to the configured
 * command and handoff budgets. This is the stable seam for per-role
 * launching that reporting and the bundled host consume.
 */
export function launchOptionsForRole(options: RoleHostRouteLaunchOptions): RoleHostLaunchOptions {
  const route = resolveRoleHostRoute(options.configuration.roles, options.role);
  return {
    harness: route.harness,
    model: route.model,
    cwd: options.cwd,
    environmentAllowlist: [...BUNDLED_CREDENTIAL_ENVIRONMENT_NAMES],
    timeoutMs: options.timeoutMs ?? options.configuration.timeouts.commandMs,
    maxOutputBytes: options.maxOutputBytes ?? options.configuration.artifacts.maxRoleHandoffBytes,
  };
}

export const ROLE_HOST_CAPABILITY_FAILURE_REASONS = [
  'unsupported-protocol',
  'not-resumable',
  'missing-role',
  'missing-profile',
  'unavailable',
] as const;

export type RoleHostCapabilityFailureReason = (typeof ROLE_HOST_CAPABILITY_FAILURE_REASONS)[number];

export class RoleHostCapabilityError extends Schema.TaggedError<RoleHostCapabilityError>()(
  'RoleHostCapabilityError',
  {
    message: Schema.String,
    reason: Schema.Literals(ROLE_HOST_CAPABILITY_FAILURE_REASONS),
    runId: Schema.optional(Schema.String),
  },
) {}

const CAPABILITY_REASON_BY_PROBLEM: Readonly<
  Record<RoleHostCapabilityProblemKind, RoleHostCapabilityFailureReason>
> = {
  protocol: 'unsupported-protocol',
  resumable: 'not-resumable',
  role: 'missing-role',
  'filesystem-profile': 'missing-profile',
  'network-profile': 'missing-profile',
};

export interface RoleHostCapabilityPreflightOptions {
  readonly configuration: ProjectConfiguration;
  readonly runId?: string;
}

/**
 * Gates a run on the bundled role host: every distinct configured harness is
 * launched from its hardcoded catalog argv (never an external command) and
 * must attest the required protocol, resumable sessions, roles, and
 * capability profiles. The model each role names is validated by the adapter
 * at every launch and fails closed against the harness catalog. Returns the
 * first harness report; callers that only gate a run discard it.
 */
export const preflightRoleHostCapabilities = Effect.fn('preflightRoleHostCapabilities')(function* (
  options: RoleHostCapabilityPreflightOptions,
): Effect.fn.Return<RoleHostCapabilitiesResponse, RoleHostCapabilityError, RoleHostLauncher> {
  const launcher = yield* RoleHostLauncher;
  const harnesses = new Map<RoleHarnessName, string>();
  for (const role of ROLE_HOST_ROLES) {
    const selection = options.configuration.roles[role];
    if (!harnesses.has(selection.harness)) {
      harnesses.set(selection.harness, selection.model);
    }
  }

  let first: RoleHostCapabilitiesResponse | undefined;
  for (const [harness, model] of harnesses) {
    const hostLayer = launcher.launch({
      harness,
      model,
      cwd: options.configuration.targetRepository,
      environmentAllowlist: [...BUNDLED_CREDENTIAL_ENVIRONMENT_NAMES],
      timeoutMs: options.configuration.timeouts.commandMs,
      maxOutputBytes: options.configuration.artifacts.maxRoleHandoffBytes,
    });

    const report = yield* Effect.gen(function* () {
      const host = yield* RoleHost;
      return yield* host.capabilities({ schemaVersion: ROLE_HOST_PROTOCOL_VERSION });
    }).pipe(
      Effect.provide(hostLayer),
      Effect.mapError(
        (error) =>
          new RoleHostCapabilityError({
            message: `The bundled role host (harness "${harness}") did not report usable capabilities: ${error.message}`,
            reason: 'unavailable',
            runId: options.runId,
          }),
      ),
    );

    const evaluation = evaluateRoleHostCapabilities(report);
    if (!evaluation.ok) {
      return yield* new RoleHostCapabilityError({
        message: `The bundled role host (harness "${harness}") is unusable: ${evaluation.problem.detail}`,
        reason: CAPABILITY_REASON_BY_PROBLEM[evaluation.problem.kind],
        runId: options.runId,
      });
    }
    first ??= report;
  }
  if (first === undefined) {
    return yield* new RoleHostCapabilityError({
      message: 'The bundled role host has no configured harness to probe.',
      reason: 'unavailable',
      runId: options.runId,
    });
  }
  return first;
});

/**
 * Verifies the bundled role host directly, without spawning anything: every
 * distinct configured harness binary must resolve on the process PATH, every
 * listed model must resolve against its harness catalog, and the bundled
 * static attestation must cover every role plus the required capability
 * profiles. Fails closed with harness-identifying errors. Doctor consumes
 * this; live runs gate through the spawning capability preflight instead.
 */
export const verifyBundledRoleHostCapabilities = Effect.fn('verifyBundledRoleHostCapabilities')(
  function* (
    options: RoleHostCapabilityPreflightOptions,
  ): Effect.fn.Return<
    RoleHostCapabilitiesResponse,
    RoleHostCapabilityError,
    RoleHostBinaryResolver
  > {
    const resolver = yield* RoleHostBinaryResolver;
    const harnesses = new Set<RoleHarnessName>();
    for (const role of ROLE_HOST_ROLES) {
      const selection = options.configuration.roles[role];
      harnesses.add(selection.harness);
      yield* resolver.resolveModel(selection.harness, selection.model);
    }
    for (const harness of harnesses) {
      yield* resolver.resolveExecutable(harness);
    }
    const evaluation = evaluateRoleHostCapabilities(BUNDLED_ROLE_HOST_CAPABILITIES);
    if (!evaluation.ok) {
      return yield* new RoleHostCapabilityError({
        message: `The bundled role host is unusable: ${evaluation.problem.detail}`,
        reason: CAPABILITY_REASON_BY_PROBLEM[evaluation.problem.kind],
        runId: options.runId,
      });
    }
    return BUNDLED_ROLE_HOST_CAPABILITIES;
  },
);

export interface RoleTurnTarget {
  readonly runDirectory: string;
  readonly runId: string;
  readonly role: RoleHostRole;
  readonly attempt: number;
  readonly generation: number;
}

/**
 * The caller-owned check of a settled control envelope. When it fails, the
 * returned problem names only the envelope errors; Foundry builds the repair
 * prompt and never lets a repair rewrite the settled Markdown narrative.
 */
export interface RoleControlValidation {
  readonly ok: boolean;
  readonly problem: string;
}

export interface RoleControlRepairPolicy {
  readonly maxRepairs: number;
  readonly validate: (control: RoleHostControl) => RoleControlValidation;
}

export interface StartOrResumeRoleTurnOptions extends RoleTurnTarget {
  readonly locations: RoleTurnLocations;
  readonly prompt: string;
  readonly deadline: string;
  readonly pollMs: number;
  readonly turnTimeoutMs: number;
  readonly controlRepair?: RoleControlRepairPolicy;
}

export type StopRoleSessionOptions = RoleTurnTarget;

interface RawSettledTurn {
  readonly session: RoleHostSessionState;
  readonly sequence: number;
  readonly narrative: string;
  readonly control: RoleHostControl;
}

export interface SettledRoleTurnResult {
  readonly outcome: 'settled';
  readonly session: RoleHostSessionState;
  readonly sequence: number;
  readonly narrative: string;
  readonly control: RoleHostControl;
  readonly controlValid: boolean;
  readonly controlProblem: string | null;
  readonly repairsPerformed: number;
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

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function controlEvidenceHash(control: RoleHostControl): string {
  return sha256Hex(JSON.stringify(control) ?? 'null');
}

function buildControlRepairPrompt(problem: string): string {
  return [
    'Your Markdown report is accepted and must not change.',
    'Correct only the machine-readable control envelope in this same session.',
    'Do not change project files, tests, Git state, or application data.',
    `Control envelope error: ${problem}`,
    'Repeat the same Markdown report followed by a corrected control envelope.',
  ].join('\n');
}

function settledResultOf(
  turn: RawSettledTurn,
  controlValid: boolean,
  controlProblem: string | null,
  repairsPerformed: number,
): SettledRoleTurnResult {
  return {
    outcome: 'settled',
    session: turn.session,
    sequence: turn.sequence,
    narrative: turn.narrative,
    control: turn.control,
    controlValid,
    controlProblem,
    repairsPerformed,
  };
}

function countControlRepairs(
  repairs: ReadonlyArray<RoleControlRepairRecord>,
  sessionId: string,
): number {
  return repairs.filter((repair) => repair.sessionId === sessionId).length;
}

function settledTurnOf(session: RoleHostSessionState): RawSettledTurn | null {
  const observation = session.lastObservation;
  if (observation === null || observation.status !== 'settled') {
    return null;
  }
  if (observation.narrative === null || observation.control === null) {
    return null;
  }
  return {
    session,
    sequence: observation.sequence,
    narrative: observation.narrative,
    control: observation.control,
  };
}

const readRoleHistory = Effect.fn('readRoleHistory')(function* (
  options: RoleTurnTarget,
): Effect.fn.Return<
  {
    readonly roleSessions: ReadonlyArray<RoleHostSessionState>;
    readonly roleControlRepairs: ReadonlyArray<RoleControlRepairRecord>;
  },
  RunHistoryError,
  RunHistoryStorage
> {
  const history = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  return {
    roleSessions: history.derived.roleSessions,
    roleControlRepairs: history.derived.roleControlRepairs,
  };
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
  guardNarrativeHash: string | null,
): Effect.fn.Return<
  RawSettledTurn,
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
      if (guardNarrativeHash !== null && sha256Hex(response.narrative) !== guardNarrativeHash) {
        return yield* conversationFailure(
          options.runId,
          'narrative-changed',
          'A control repair changed the Markdown report that must stay unchanged.',
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
    const derived = deriveRoleHostAccessScope(options.role, options.locations);
    if (!derived.ok) {
      return yield* conversationFailure(
        options.runId,
        'permission-profile-unavailable',
        `Run "${options.runId}" cannot derive an enforceable access scope for role "${options.role}": ${derived.problem.detail}`,
      );
    }
    const scope = derived.scope;
    const created = yield* host.create({
      schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
      runId: options.runId,
      role: options.role,
      attempt: options.attempt,
      generation: options.generation,
      workingDirectory: scope.workingDirectory,
      readRoots: [...scope.readRoots],
      writeRoots: [...scope.writeRoots],
      networkAllowlist: [...scope.networkAllowlist],
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
            workingDirectory: scope.workingDirectory,
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

  const pendingRepair = history.roleControlRepairs.find(
    (repair) => repair.sessionId === session.sessionId && repair.observation === null,
  );

  const performControlRepair = Effect.fn('startOrResumeRoleTurn.performControlRepair')(function* (
    rejected: RawSettledTurn,
    problem: string,
    existing: RoleControlRepairRecord | null,
  ): Effect.fn.Return<
    RawSettledTurn,
    RoleConversationError | RoleHostOperationalError | RunHistoryError,
    RoleHost | RunHistoryStorage
  > {
    const sessionId = rejected.session.sessionId;
    const generation = rejected.session.generation;
    const narrativeHash = sha256Hex(rejected.narrative);
    const controlHash = controlEvidenceHash(rejected.control);
    const prompt = buildControlRepairPrompt(problem);
    const promptHash = sha256Hex(prompt);
    let idempotencyKey = existing?.idempotencyKey ?? '';
    let submissionStarted = existing?.submission ?? null;

    if (existing === null) {
      yield* appendRunEvent({
        runDirectory: options.runDirectory,
        runId: options.runId,
        createIfMissing: false,
        build: () =>
          Effect.succeed({
            type: 'role-control-rejected',
            payload: {
              sessionId,
              generation,
              sequence: rejected.sequence,
              narrativeHash,
              controlHash,
              problem,
            },
          } as const),
      });
    }
    if (idempotencyKey.length === 0) {
      idempotencyKey = randomUUID();
      yield* appendRunEvent({
        runDirectory: options.runDirectory,
        runId: options.runId,
        createIfMissing: false,
        build: () =>
          Effect.succeed({
            type: 'role-control-repair-requested',
            payload: {
              sessionId,
              generation,
              idempotencyKey,
              promptHash,
              baselineSequence: rejected.sequence,
              problem,
            },
          } as const),
      });
    }
    if (submissionStarted === null) {
      const response = yield* host
        .submit({
          schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          sessionId,
          ownershipToken: rejected.session.ownershipToken,
          generation,
          idempotencyKey,
          prompt,
          deadline: options.deadline,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new RoleConversationError({
                message: `The control repair for session "${sessionId}" may have been accepted and cannot be repeated safely: ${error.message}`,
                reason: 'ambiguous-submission',
                runId: options.runId,
              }),
          ),
        );
      submissionStarted = response.submission;
      yield* appendRunEvent({
        runDirectory: options.runDirectory,
        runId: options.runId,
        createIfMissing: false,
        build: () =>
          Effect.succeed({
            type: 'role-control-repair-started',
            payload: { sessionId, generation, idempotencyKey, submission: response.submission },
          } as const),
      });
    }
    return yield* observeUntilSettled(options, rejected.session, narrativeHash).pipe(
      Effect.timeout(Duration.millis(options.turnTimeoutMs)),
      Effect.catchTag(
        'TimeoutError',
        () =>
          new RoleConversationError({
            message: `The control repair for session "${sessionId}" did not settle within ${options.turnTimeoutMs}ms.`,
            reason: 'turn-timeout',
            runId: options.runId,
          }),
      ),
    );
  });

  const finishSettledTurn = Effect.fn('startOrResumeRoleTurn.finishSettledTurn')(function* (
    turn: RawSettledTurn,
    priorRepairs: number,
  ): Effect.fn.Return<
    SettledRoleTurnResult,
    RoleConversationError | RoleHostOperationalError | RunHistoryError,
    RoleHost | RunHistoryStorage
  > {
    const policy = options.controlRepair;
    if (policy === undefined) {
      return settledResultOf(turn, true, null, priorRepairs);
    }
    let current = turn;
    let performed = priorRepairs;
    while (true) {
      const validation = policy.validate(current.control);
      if (validation.ok) {
        return settledResultOf(current, true, null, performed);
      }
      if (performed >= policy.maxRepairs) {
        return settledResultOf(current, false, validation.problem, performed);
      }
      current = yield* performControlRepair(current, validation.problem, null);
      performed += 1;
    }
  });

  if (pendingRepair !== undefined) {
    const rejected = settledTurnOf(session);
    if (rejected === null) {
      return yield* conversationFailure(
        options.runId,
        'session-missing',
        `The pending control repair for session "${session.sessionId}" has no settled report to preserve.`,
      );
    }
    const repaired = yield* performControlRepair(rejected, pendingRepair.problem, pendingRepair);
    return yield* finishSettledTurn(
      repaired,
      countControlRepairs(history.roleControlRepairs, session.sessionId),
    );
  }

  const alreadySettled = settledTurnOf(session);
  if (alreadySettled !== null) {
    return yield* finishSettledTurn(
      alreadySettled,
      countControlRepairs(history.roleControlRepairs, session.sessionId),
    );
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

  const settled = yield* observeUntilSettled(options, session, null).pipe(
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
  return yield* finishSettledTurn(settled, 0);
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
