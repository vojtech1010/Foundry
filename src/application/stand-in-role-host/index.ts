import { Effect, Layer, Schema } from 'effect';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  ROLE_HOST_FILESYSTEM_PROFILES,
  ROLE_HOST_NETWORK_PROFILES,
  ROLE_HOST_PROTOCOL_NAME,
  ROLE_HOST_PROTOCOL_VERSION,
  ROLE_HOST_ROLES,
} from '../../domain/role-host.js';
import {
  RoleHost,
  RoleHostLauncher,
  RoleHostOperationalError,
} from '../role-conversations/index.js';

import type {
  RoleHostCapabilitiesResponse,
  RoleHostControl,
  RoleHostCreateRequest,
  RoleHostCreateResponse,
  RoleHostObserveResponse,
  RoleHostRole,
  RoleHostStopResponse,
  RoleHostSubmitResponse,
} from '../../domain/role-host.js';

/**
 * The in-process stand-in role host. It serves the same `foundry-role-host-v1`
 * machine envelopes, session lifecycle, and permission roots as a live adapter
 * so a full Architect -> Coder -> checks -> optional Tester -> Reviewer walk can
 * run without a vendor agent.
 *
 * It is deliberately not a product mode: it is a `Layer` substituted for
 * `RoleHostLauncher` in the composition root, exactly like the process adapter.
 * Workflow routing, publication policy, and role write permissions continue to
 * come from Foundry-owned configuration and Git state rather than from the host.
 *
 * A scripted turn may carry a side effect (`act`) so a caller can model the
 * role's observable work, such as a Coder commit inside the run-owned worktree
 * or a deliberately misbehaving read-only mutation that the governed-turn
 * resource observer must detect. The module never performs filesystem work
 * itself; the caller supplies that capability from its own layer.
 */

export const STAND_IN_ROLE_HOST_ADAPTER_VERSION = 'stand-in-1';

export const STAND_IN_ROLE_HOST_CAPABILITIES: RoleHostCapabilitiesResponse = {
  schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
  protocol: ROLE_HOST_PROTOCOL_NAME,
  resumable: true,
  availableRoles: [...ROLE_HOST_ROLES],
  capabilityProfiles: {
    filesystem: [...ROLE_HOST_FILESYSTEM_PROFILES],
    network: [...ROLE_HOST_NETWORK_PROFILES],
  },
  adapterVersion: STAND_IN_ROLE_HOST_ADAPTER_VERSION,
};

/**
 * The resolved, permission-checked access scope a scripted turn receives. It is
 * the same shape Foundry derives from run-owned locations, so a turn can only
 * model work inside the roots the governed-turn layer already recorded.
 */
export interface StandInTurnContext {
  readonly role: RoleHostRole;
  readonly workingDirectory: string;
  readonly readRoots: ReadonlyArray<string>;
  readonly writeRoots: ReadonlyArray<string>;
  readonly networkAllowlist: ReadonlyArray<string>;
}

export class StandInTurnActError extends Schema.TaggedError<StandInTurnActError>()(
  'StandInTurnActError',
  {
    message: Schema.String,
  },
) {}

export type StandInTurnAct = (
  context: StandInTurnContext,
) => Effect.Effect<void, StandInTurnActError>;

export interface StandInSettledTurn {
  readonly status?: 'settled';
  readonly narrative: string;
  readonly control: RoleHostControl;
  readonly act?: StandInTurnAct;
}

export interface StandInLostTurn {
  readonly status: 'lost';
}

export type StandInTurn = StandInSettledTurn | StandInLostTurn;

export type StandInTurnSequence = StandInTurn | ReadonlyArray<StandInTurn>;

export type StandInRoleHostScript = Partial<Record<RoleHostRole, StandInTurnSequence>>;

interface StandInSession {
  readonly sessionId: string;
  readonly ownershipToken: string;
  readonly role: RoleHostRole;
  readonly generation: number;
  readonly workingDirectory: string;
  readonly readRoots: ReadonlyArray<string>;
  readonly writeRoots: ReadonlyArray<string>;
  readonly networkAllowlist: ReadonlyArray<string>;
  turnIndex: number;
  readonly submittedKeys: Set<string>;
  stopDisposition: 'disposed' | null;
}

function isLostTurn(turn: StandInTurn): turn is StandInLostTurn {
  return turn.status === 'lost';
}

function isTurnSequenceArray(
  sequence: StandInTurnSequence,
): sequence is ReadonlyArray<StandInTurn> {
  return Array.isArray(sequence);
}

function isWithin(parent: string, child: string): boolean {
  const root = resolve(parent);
  const target = resolve(child);
  const relativePath = relative(root, target);
  return relativePath.length === 0 || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function isAbsoluteRoot(path: string): boolean {
  return isAbsolute(path);
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.pathname === '/';
  } catch {
    return false;
  }
}

/**
 * The stand-in enforces the closed role permission model before a session is
 * created, mirroring a live adapter's refusal to start a turn it cannot bound.
 * It fails closed on a missing working directory, a write root outside every
 * read root, a read-only role that may write its production snapshot, a Coder
 * that cannot write its run-owned workspace, or a network grant the role does
 * not hold. Foundry's derived scopes always satisfy this model.
 */
export function evaluateStandInCreateRequest(request: RoleHostCreateRequest): string | null {
  const workingDirectory = request.workingDirectory;
  if (workingDirectory === undefined || workingDirectory.length === 0) {
    return `Stand-in role "${request.role}" requires an absolute working directory.`;
  }
  if (!isAbsoluteRoot(workingDirectory)) {
    return `Stand-in role "${request.role}" requires an absolute working directory, received "${workingDirectory}".`;
  }
  const readRoots = request.readRoots ?? [];
  const writeRoots = request.writeRoots ?? [];
  const networkAllowlist = request.networkAllowlist ?? [];
  const allRoots = [...readRoots, ...writeRoots];
  if (allRoots.some((root) => !isAbsoluteRoot(root))) {
    return `Stand-in role "${request.role}" requires every read and write root to be an absolute path.`;
  }
  if (!readRoots.some((root) => isWithin(root, workingDirectory))) {
    return `Stand-in role "${request.role}" cannot read its working directory "${workingDirectory}".`;
  }
  for (const writeRoot of writeRoots) {
    if (!readRoots.some((readRoot) => isWithin(readRoot, writeRoot))) {
      return `Stand-in role "${request.role}" may not write "${writeRoot}" outside every read root.`;
    }
  }
  const readOnly = request.role !== 'coder' && request.role !== 'lead_coder';
  if (readOnly) {
    for (const writeRoot of writeRoots) {
      if (readRoots.some((readRoot) => resolve(readRoot) === resolve(writeRoot))) {
        return `Read-only stand-in role "${request.role}" may not write the read-only root "${writeRoot}".`;
      }
    }
  } else if (!writeRoots.some((writeRoot) => isWithin(writeRoot, workingDirectory))) {
    return `Stand-in role "${request.role}" must be allowed to write its run-owned workspace "${workingDirectory}".`;
  }
  if (request.role === 'tester') {
    if (networkAllowlist.length !== 1 || !networkAllowlist.every(isOrigin)) {
      return 'Stand-in Tester requires exactly one prepared runtime origin and nothing else.';
    }
  } else if (networkAllowlist.length > 0) {
    return `Stand-in role "${request.role}" must not be granted network access.`;
  }
  return null;
}

function defaultControlFor(role: RoleHostRole): RoleHostControl {
  switch (role) {
    case 'architect':
      return {
        schemaVersion: 1,
        outcome: 'plan_ready',
        acceptanceCriteria: ['the scripted criterion'],
        runtimeValidation: 'not_required',
        execution: 'sequential',
      };
    case 'coder':
    case 'lead_coder':
      return { schemaVersion: 1, outcome: 'no_change_candidate' };
    case 'tester':
      return { schemaVersion: 1, outcome: 'observed' };
    case 'reviewer':
      return { schemaVersion: 1, outcome: 'approved' };
  }
}

function selectTurn(script: StandInRoleHostScript, role: RoleHostRole, index: number): StandInTurn {
  const configured = script[role];
  if (configured === undefined) {
    return { narrative: `${role} settled.`, control: defaultControlFor(role) };
  }
  if (isTurnSequenceArray(configured)) {
    const chosen = configured[Math.min(index, configured.length - 1)];
    return chosen ?? { narrative: `${role} settled.`, control: defaultControlFor(role) };
  }
  return configured;
}

function operational(operation: 'create' | 'submit' | 'observe' | 'stop', message: string) {
  return new RoleHostOperationalError({ message, operation });
}

/**
 * Builds a deterministic in-process host and launcher Layer. The same host
 * object is shared across the launcher, so scripted turn counters and stop
 * dispositions persist for the whole run even though Foundry provides the
 * launched host per governed turn.
 */
export function standInRoleHost(
  script: StandInRoleHostScript = {},
): Layer.Layer<RoleHost | RoleHostLauncher> {
  const sessions = new Map<string, StandInSession>();
  const turnCounters = new Map<RoleHostRole, number>();

  const hostLayer = Layer.succeed(
    RoleHost,
    RoleHost.of({
      capabilities: () => Effect.succeed(STAND_IN_ROLE_HOST_CAPABILITIES),
      create: (request): Effect.Effect<RoleHostCreateResponse, RoleHostOperationalError> =>
        Effect.gen(function* () {
          const problem = evaluateStandInCreateRequest(request);
          if (problem !== null) {
            return yield* operational('create', problem);
          }
          const sessionId = `stand-in-${request.role}-${request.attempt}-${request.generation}`;
          const ownershipToken = `stand-in-owner-${sessionId}`;
          const workingDirectory = request.workingDirectory ?? '';
          const session: StandInSession = {
            sessionId,
            ownershipToken,
            role: request.role,
            generation: request.generation,
            workingDirectory,
            readRoots: [...(request.readRoots ?? [])],
            writeRoots: [...(request.writeRoots ?? [])],
            networkAllowlist: [...(request.networkAllowlist ?? [])],
            turnIndex: 0,
            submittedKeys: new Set(),
            stopDisposition: null,
          };
          sessions.set(sessionId, session);
          return {
            schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
            sessionId,
            ownershipToken,
            generation: request.generation,
            sequence: 0,
            runtimeIdentity: {
              adapterVersion: STAND_IN_ROLE_HOST_ADAPTER_VERSION,
              provider: 'stand-in',
              model: 'stand-in',
              toolProfile: 'stand-in',
            },
          };
        }),
      submit: (request): Effect.Effect<RoleHostSubmitResponse, RoleHostOperationalError> =>
        Effect.gen(function* () {
          const session = sessions.get(request.sessionId);
          if (
            session === undefined ||
            session.ownershipToken !== request.ownershipToken ||
            session.generation !== request.generation
          ) {
            return yield* operational(
              'submit',
              `The stand-in host does not own session "${request.sessionId}".`,
            );
          }
          if (session.submittedKeys.has(request.idempotencyKey)) {
            return {
              schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
              submission: 'already_accepted' as const,
            };
          }
          session.submittedKeys.add(request.idempotencyKey);
          const index = turnCounters.get(session.role) ?? 0;
          turnCounters.set(session.role, index + 1);
          session.turnIndex = index;
          const turn = selectTurn(script, session.role, index);
          if (!isLostTurn(turn) && turn.act !== undefined) {
            const context: StandInTurnContext = {
              role: session.role,
              workingDirectory: session.workingDirectory,
              readRoots: session.readRoots,
              writeRoots: session.writeRoots,
              networkAllowlist: session.networkAllowlist,
            };
            yield* turn
              .act(context)
              .pipe(
                Effect.mapError((error) =>
                  operational('submit', `The stand-in turn effect failed: ${error.message}`),
                ),
              );
          }
          return {
            schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
            submission: 'accepted' as const,
          };
        }),
      observe: (request): Effect.Effect<RoleHostObserveResponse, RoleHostOperationalError> =>
        Effect.gen(function* () {
          const session = sessions.get(request.sessionId);
          if (
            session === undefined ||
            session.ownershipToken !== request.ownershipToken ||
            session.generation !== request.generation
          ) {
            return yield* operational(
              'observe',
              `The stand-in host does not own session "${request.sessionId}".`,
            );
          }
          const sequence = request.afterSequence + 1;
          const turn = selectTurn(script, session.role, session.turnIndex);
          if (isLostTurn(turn)) {
            return {
              schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
              status: 'lost' as const,
              sequence,
              events: [],
            };
          }
          return {
            schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
            status: 'settled' as const,
            sequence,
            events: [],
            narrative: turn.narrative,
            control: turn.control,
          };
        }),
      stop: (request): Effect.Effect<RoleHostStopResponse, RoleHostOperationalError> =>
        Effect.gen(function* () {
          const session = sessions.get(request.sessionId);
          if (
            session === undefined ||
            session.ownershipToken !== request.ownershipToken ||
            session.generation !== request.generation
          ) {
            return yield* operational(
              'stop',
              `The stand-in host does not own session "${request.sessionId}".`,
            );
          }
          if (session.stopDisposition !== null) {
            return {
              schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
              disposition: 'already_disposed' as const,
            };
          }
          session.stopDisposition = 'disposed';
          return {
            schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
            disposition: 'disposed' as const,
          };
        }),
    }),
  );

  const launcherLayer = Layer.succeed(
    RoleHostLauncher,
    RoleHostLauncher.of({ launch: () => hostLayer }),
  );

  return Layer.merge(hostLayer, launcherLayer);
}
