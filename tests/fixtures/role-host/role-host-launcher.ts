import { Effect, Layer } from 'effect';

import { RoleHost, RoleHostLauncher } from '../../../src/application/role-conversations/index.js';
import {
  ROLE_HOST_FILESYSTEM_PROFILES,
  ROLE_HOST_NETWORK_PROFILES,
  ROLE_HOST_PROTOCOL_NAME,
  ROLE_HOST_PROTOCOL_VERSION,
  ROLE_HOST_ROLES,
} from '../../../src/domain/role-host.js';

import type { RoleHostCapabilitiesResponse } from '../../../src/domain/role-host.js';

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
