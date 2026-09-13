import { Effect, Layer } from 'effect';

import { RoleHost, RoleHostLauncher } from '../../../src/application/role-conversations/index.js';
import {
  ROLE_HOST_FILESYSTEM_PROFILES,
  ROLE_HOST_NETWORK_PROFILES,
  ROLE_HOST_PROTOCOL_NAME,
  ROLE_HOST_PROTOCOL_VERSION,
  ROLE_HOST_ROLES,
} from '../../../src/domain/role-host.js';

import type { Schema } from 'effect';

import type { RoleHostCapabilitiesResponse, RoleHostRole } from '../../../src/domain/role-host.js';

export const CAPABLE_ROLE_HOST_CAPABILITIES: RoleHostCapabilitiesResponse = {
  schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
  protocol: ROLE_HOST_PROTOCOL_NAME,
  resumable: true,
  availableRoles: [...ROLE_HOST_ROLES],
  capabilityProfiles: {
    filesystem: [...ROLE_HOST_FILESYSTEM_PROFILES],
    network: [...ROLE_HOST_NETWORK_PROFILES],
  },
  adapterVersion: 'fake-capability-1',
};

export function roleHostLauncherWith(
  capabilities: RoleHostCapabilitiesResponse,
): Layer.Layer<RoleHostLauncher> {
  return Layer.succeed(
    RoleHostLauncher,
    RoleHostLauncher.of({
      launch: () =>
        Layer.succeed(
          RoleHost,
          RoleHost.of({
            capabilities: () => Effect.succeed(capabilities),
            create: () => Effect.die(new Error('the capability test host cannot create sessions')),
            submit: () => Effect.die(new Error('the capability test host cannot submit turns')),
            observe: () => Effect.die(new Error('the capability test host cannot observe turns')),
            stop: () => Effect.die(new Error('the capability test host cannot stop sessions')),
          }),
        ),
    }),
  );
}

export function capableRoleHostLauncher(): Layer.Layer<RoleHostLauncher> {
  return roleHostLauncherWith(CAPABLE_ROLE_HOST_CAPABILITIES);
}

export function incapableRoleHostLauncher(
  overrides: Partial<RoleHostCapabilitiesResponse>,
): Layer.Layer<RoleHostLauncher> {
  return roleHostLauncherWith({ ...CAPABLE_ROLE_HOST_CAPABILITIES, ...overrides });
}

export interface ScriptedRoleTurn {
  readonly narrative: string;
  readonly control: Schema.JsonObject;
}

export function defaultControlFor(role: RoleHostRole): Schema.JsonObject {
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
      return { schemaVersion: 1, outcome: 'no_change_candidate' };
    case 'lead_coder':
      return { schemaVersion: 1, outcome: 'no_change_candidate' };
    case 'tester':
      return { schemaVersion: 1, outcome: 'observed' };
    case 'reviewer':
      return { schemaVersion: 1, outcome: 'approved' };
  }
}

/**
 * A deterministic role host for run-loop tests. Each created session is settled
 * on the first observe with the configured control and narrative for its role.
 */
export function scriptedRoleHostLauncher(
  turns: Partial<Record<RoleHostRole, ScriptedRoleTurn | ReadonlyArray<ScriptedRoleTurn>>>,
): Layer.Layer<RoleHostLauncher> {
  const roles = new Map<string, RoleHostRole>();
  const counters = new Map<RoleHostRole, number>();
  const hostLayer = Layer.succeed(
    RoleHost,
    RoleHost.of({
      capabilities: () => Effect.succeed(CAPABLE_ROLE_HOST_CAPABILITIES),
      create: (request) =>
        Effect.sync(() => {
          const sessionId = `session-${request.role}-${request.attempt}-${request.generation}`;
          roles.set(sessionId, request.role);
          return {
            schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
            sessionId,
            ownershipToken: `owner-${sessionId}`,
            generation: request.generation,
            sequence: 0,
            runtimeIdentity: {
              adapterVersion: 'scripted-1',
              provider: 'scripted',
              model: 'scripted',
              toolProfile: 'scripted',
            },
          };
        }),
      submit: () =>
        Effect.succeed({
          schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          submission: 'accepted',
        }),
      observe: (request) =>
        Effect.sync(() => {
          const role = roles.get(request.sessionId) ?? 'architect';
          const index = counters.get(role) ?? 0;
          counters.set(role, index + 1);
          const configured = turns[role];
          const scripted = Array.isArray(configured)
            ? (configured[Math.min(index, configured.length - 1)] ?? undefined)
            : configured;
          return {
            schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
            status: 'settled' as const,
            sequence: request.afterSequence + 1,
            events: [],
            narrative: scripted?.narrative ?? `${role} settled.`,
            control: scripted?.control ?? defaultControlFor(role),
          };
        }),
      stop: () =>
        Effect.succeed({
          schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          disposition: 'disposed',
        }),
    }),
  );
  return Layer.succeed(
    RoleHostLauncher,
    RoleHostLauncher.of({
      launch: () => hostLayer,
    }),
  );
}
