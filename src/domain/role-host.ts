import { Schema } from 'effect';

import { ROLE_HARNESS_PROTOCOL } from './project-configuration.js';
import { Identifier } from './run-identity.js';

import type { RoleHarnessName, RoleHarnessSelections } from './project-configuration.js';

export const ROLE_HOST_PROTOCOL_VERSION = 1 as const;

export const ROLE_HOST_PROTOCOL_NAME = ROLE_HARNESS_PROTOCOL;

export const ROLE_HOST_OPERATIONS = [
  'capabilities',
  'create',
  'submit',
  'observe',
  'stop',
] as const;

export type RoleHostOperation = (typeof ROLE_HOST_OPERATIONS)[number];

export const ROLE_HOST_ROLES = ['architect', 'coder', 'lead_coder', 'tester', 'reviewer'] as const;

export type RoleHostRole = (typeof ROLE_HOST_ROLES)[number];

/**
 * The resolved routing for one role: which harness to launch and which model
 * it must serve. Resolution is a pure projection of the configuration
 * document, so the same document resolves the same routing on Linux and
 * Windows; only executable resolution inside the adapter follows platform
 * rules. This is the stable contract that reporting (`doctor`,
 * `init --dry-run`) and launching consume.
 */
export interface RoleHostRoute {
  readonly role: RoleHostRole;
  readonly harness: RoleHarnessName;
  readonly model: string;
}

export function resolveRoleHostRoute(
  selections: RoleHarnessSelections,
  role: RoleHostRole,
): RoleHostRoute {
  const selection = selections[role];
  return { role, harness: selection.harness, model: selection.model };
}

/** The resolved routing for every role, keyed by role. */
export interface RoleHostRoutes {
  readonly architect: RoleHostRoute;
  readonly coder: RoleHostRoute;
  readonly lead_coder: RoleHostRoute;
  readonly tester: RoleHostRoute;
  readonly reviewer: RoleHostRoute;
}

export function resolveAllRoleHostRoutes(selections: RoleHarnessSelections): RoleHostRoutes {
  return {
    architect: resolveRoleHostRoute(selections, 'architect'),
    coder: resolveRoleHostRoute(selections, 'coder'),
    lead_coder: resolveRoleHostRoute(selections, 'lead_coder'),
    tester: resolveRoleHostRoute(selections, 'tester'),
    reviewer: resolveRoleHostRoute(selections, 'reviewer'),
  };
}

export const ROLE_HOST_FILESYSTEM_PROFILES = [
  'read_only_snapshot',
  'run_owned_worktree',
  'owned_scratch',
  'owned_capture_scratch',
] as const;

export type RoleHostFilesystemProfile = (typeof ROLE_HOST_FILESYSTEM_PROFILES)[number];

export const ROLE_HOST_NETWORK_PROFILES = ['network_denied', 'runtime_origin_only'] as const;

/**
 * Build identifier for the Foundry-bundled role host. The bundled host is
 * Foundry's own ship: launch argv, model catalogs, and credential names are
 * hardcoded per harness, so one version identifies the whole adapter
 * contract. Bump it when the catalog or protocol surface changes.
 */
export const BUNDLED_ROLE_HOST_ADAPTER_VERSION = 'bundled-1' as const;

/**
 * The bundled host's static capability attestation. Foundry ships the host,
 * so protocol, resumable sessions, runnable roles, and enforceable profiles
 * are known without spawning anything; `evaluateRoleHostCapabilities`
 * guards this table against drift from the required role/profile matrix.
 */
export const BUNDLED_ROLE_HOST_CAPABILITIES: RoleHostCapabilitiesResponse = {
  schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
  protocol: ROLE_HOST_PROTOCOL_NAME,
  resumable: true,
  availableRoles: [...ROLE_HOST_ROLES],
  capabilityProfiles: {
    filesystem: [...ROLE_HOST_FILESYSTEM_PROFILES],
    network: [...ROLE_HOST_NETWORK_PROFILES],
  },
  adapterVersion: BUNDLED_ROLE_HOST_ADAPTER_VERSION,
};

export type RoleHostNetworkProfile = (typeof ROLE_HOST_NETWORK_PROFILES)[number];

export interface RoleHostRoleRequirement {
  readonly filesystem: ReadonlyArray<RoleHostFilesystemProfile>;
  readonly network: ReadonlyArray<RoleHostNetworkProfile>;
}

export const ROLE_HOST_ROLE_REQUIREMENTS: Readonly<Record<RoleHostRole, RoleHostRoleRequirement>> =
  {
    architect: {
      filesystem: ['read_only_snapshot', 'owned_scratch'],
      network: ['network_denied'],
    },
    coder: {
      filesystem: ['run_owned_worktree', 'owned_scratch'],
      network: ['network_denied'],
    },
    lead_coder: {
      filesystem: ['run_owned_worktree', 'owned_scratch'],
      network: ['network_denied'],
    },
    tester: {
      filesystem: ['read_only_snapshot', 'owned_capture_scratch'],
      network: ['runtime_origin_only'],
    },
    reviewer: {
      filesystem: ['read_only_snapshot', 'owned_scratch'],
      network: ['network_denied'],
    },
  };

export const ROLE_HOST_STATUSES = ['active', 'settled', 'lost'] as const;

export type RoleHostStatus = (typeof ROLE_HOST_STATUSES)[number];

export const ROLE_HOST_SUBMISSIONS = ['accepted', 'already_accepted'] as const;

export type RoleHostSubmission = (typeof ROLE_HOST_SUBMISSIONS)[number];

export const ROLE_HOST_DISPOSITIONS = ['disposed', 'already_disposed'] as const;

export type RoleHostDisposition = (typeof ROLE_HOST_DISPOSITIONS)[number];

const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const RoleHostInstant = Schema.String.check(Schema.isPattern(UTC_INSTANT_PATTERN));

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));

const NonNegativeInteger = Schema.Natural;

const StringList = Schema.Array(Schema.NonEmptyString);

export const RoleHostRuntimeIdentitySchema = Schema.Struct({
  adapterVersion: Schema.NonEmptyString,
  provider: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  toolProfile: Schema.NonEmptyString,
});

export type RoleHostRuntimeIdentity = (typeof RoleHostRuntimeIdentitySchema)['Type'];

export const RoleHostEventSchema = Schema.Struct({
  sequence: NonNegativeInteger,
  kind: Schema.NonEmptyString,
  text: Schema.String,
});

export type RoleHostEvent = (typeof RoleHostEventSchema)['Type'];

export const RoleHostControlSchema = Schema.JsonObject;

export type RoleHostControl = (typeof RoleHostControlSchema)['Type'];

export const RoleHostNarrativeSchema = Schema.NonEmptyString;

export const RoleHostCreateRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ROLE_HOST_PROTOCOL_VERSION),
  runId: Identifier,
  role: Schema.Literals(ROLE_HOST_ROLES),
  attempt: PositiveInteger,
  generation: PositiveInteger,
  workingDirectory: Schema.optional(Schema.NonEmptyString),
  readRoots: Schema.optional(StringList),
  writeRoots: Schema.optional(StringList),
  networkAllowlist: Schema.optional(StringList),
});

export type RoleHostCreateRequest = (typeof RoleHostCreateRequestSchema)['Type'];

export const RoleHostCreateResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ROLE_HOST_PROTOCOL_VERSION),
  sessionId: Schema.NonEmptyString,
  ownershipToken: Schema.NonEmptyString,
  generation: PositiveInteger,
  sequence: NonNegativeInteger,
  runtimeIdentity: RoleHostRuntimeIdentitySchema,
});

export type RoleHostCreateResponse = (typeof RoleHostCreateResponseSchema)['Type'];

export const RoleHostSubmitRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ROLE_HOST_PROTOCOL_VERSION),
  sessionId: Schema.NonEmptyString,
  ownershipToken: Schema.NonEmptyString,
  generation: PositiveInteger,
  idempotencyKey: Schema.NonEmptyString,
  prompt: Schema.NonEmptyString,
  deadline: RoleHostInstant,
});

export type RoleHostSubmitRequest = (typeof RoleHostSubmitRequestSchema)['Type'];

export const RoleHostSubmitResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ROLE_HOST_PROTOCOL_VERSION),
  submission: Schema.Literals(ROLE_HOST_SUBMISSIONS),
});

export type RoleHostSubmitResponse = (typeof RoleHostSubmitResponseSchema)['Type'];

export const RoleHostObserveRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ROLE_HOST_PROTOCOL_VERSION),
  sessionId: Schema.NonEmptyString,
  ownershipToken: Schema.NonEmptyString,
  generation: PositiveInteger,
  afterSequence: NonNegativeInteger,
});

export type RoleHostObserveRequest = (typeof RoleHostObserveRequestSchema)['Type'];

export const RoleHostObserveActiveResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ROLE_HOST_PROTOCOL_VERSION),
  status: Schema.Literal('active'),
  sequence: NonNegativeInteger,
  events: Schema.Array(RoleHostEventSchema),
});

export const RoleHostObserveSettledResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ROLE_HOST_PROTOCOL_VERSION),
  status: Schema.Literal('settled'),
  sequence: NonNegativeInteger,
  events: Schema.Array(RoleHostEventSchema),
  narrative: RoleHostNarrativeSchema,
  control: RoleHostControlSchema,
});

export const RoleHostObserveLostResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ROLE_HOST_PROTOCOL_VERSION),
  status: Schema.Literal('lost'),
  sequence: NonNegativeInteger,
  events: Schema.Array(RoleHostEventSchema),
});

export const RoleHostObserveResponseSchema = Schema.Union([
  RoleHostObserveActiveResponseSchema,
  RoleHostObserveSettledResponseSchema,
  RoleHostObserveLostResponseSchema,
]);

export type RoleHostObserveResponse = (typeof RoleHostObserveResponseSchema)['Type'];

export type RoleHostObserveSettledResponse = (typeof RoleHostObserveSettledResponseSchema)['Type'];

export const RoleHostStopRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ROLE_HOST_PROTOCOL_VERSION),
  sessionId: Schema.NonEmptyString,
  ownershipToken: Schema.NonEmptyString,
  generation: PositiveInteger,
});

export type RoleHostStopRequest = (typeof RoleHostStopRequestSchema)['Type'];

export const RoleHostStopResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ROLE_HOST_PROTOCOL_VERSION),
  disposition: Schema.Literals(ROLE_HOST_DISPOSITIONS),
});

export type RoleHostStopResponse = (typeof RoleHostStopResponseSchema)['Type'];

export const RoleHostCapabilitiesRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ROLE_HOST_PROTOCOL_VERSION),
});

export type RoleHostCapabilitiesRequest = (typeof RoleHostCapabilitiesRequestSchema)['Type'];

export const RoleHostCapabilityProfilesSchema = Schema.Struct({
  filesystem: Schema.Array(Schema.Literals(ROLE_HOST_FILESYSTEM_PROFILES)),
  network: Schema.Array(Schema.Literals(ROLE_HOST_NETWORK_PROFILES)),
});

export type RoleHostCapabilityProfiles = (typeof RoleHostCapabilityProfilesSchema)['Type'];

export const RoleHostCapabilitiesResponseSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ROLE_HOST_PROTOCOL_VERSION),
  protocol: Schema.NonEmptyString,
  resumable: Schema.Boolean,
  availableRoles: Schema.Array(Schema.Literals(ROLE_HOST_ROLES)),
  capabilityProfiles: RoleHostCapabilityProfilesSchema,
  adapterVersion: Schema.NonEmptyString,
});

export type RoleHostCapabilitiesResponse = (typeof RoleHostCapabilitiesResponseSchema)['Type'];

export type RoleHostCapabilityProblemKind =
  | 'protocol'
  | 'resumable'
  | 'role'
  | 'filesystem-profile'
  | 'network-profile';

export interface RoleHostCapabilityProblem {
  readonly kind: RoleHostCapabilityProblemKind;
  readonly detail: string;
}

export type RoleHostCapabilityEvaluation =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: RoleHostCapabilityProblem };

export function evaluateRoleHostCapabilities(
  report: RoleHostCapabilitiesResponse,
): RoleHostCapabilityEvaluation {
  if (report.protocol !== ROLE_HOST_PROTOCOL_NAME) {
    return {
      ok: false,
      problem: {
        kind: 'protocol',
        detail: `The role host reports protocol "${report.protocol}", but Foundry requires "${ROLE_HOST_PROTOCOL_NAME}".`,
      },
    };
  }
  if (!report.resumable) {
    return {
      ok: false,
      problem: {
        kind: 'resumable',
        detail: 'The role host does not attest resumable sessions.',
      },
    };
  }
  for (const role of ROLE_HOST_ROLES) {
    if (!report.availableRoles.includes(role)) {
      return {
        ok: false,
        problem: {
          kind: 'role',
          detail: `The role host cannot run the required role "${role}".`,
        },
      };
    }
  }
  for (const role of ROLE_HOST_ROLES) {
    const requirement = ROLE_HOST_ROLE_REQUIREMENTS[role];
    for (const profile of requirement.filesystem) {
      if (!report.capabilityProfiles.filesystem.includes(profile)) {
        return {
          ok: false,
          problem: {
            kind: 'filesystem-profile',
            detail: `The role host does not enforce the "${profile}" filesystem profile required by role "${role}".`,
          },
        };
      }
    }
    for (const profile of requirement.network) {
      if (!report.capabilityProfiles.network.includes(profile)) {
        return {
          ok: false,
          problem: {
            kind: 'network-profile',
            detail: `The role host does not enforce the "${profile}" network profile required by role "${role}".`,
          },
        };
      }
    }
  }
  return { ok: true };
}

export interface RoleHostSubmissionIntent {
  readonly idempotencyKey: string;
  readonly promptHash: string;
  readonly baselineSequence: number;
}

export interface RoleHostObservation {
  readonly status: RoleHostStatus;
  readonly sequence: number;
  readonly eventCount: number;
  readonly narrative: string | null;
  readonly control: RoleHostControl | null;
}

export interface RoleHostSessionState {
  readonly role: RoleHostRole;
  readonly attempt: number;
  readonly generation: number;
  readonly sessionId: string;
  readonly ownershipToken: string;
  readonly initialSequence: number;
  readonly runtimeIdentity: RoleHostRuntimeIdentity;
  readonly workingDirectory: string | null;
  readonly submission: RoleHostSubmissionIntent | null;
  readonly submissionStarted: RoleHostSubmission | null;
  readonly lastObservation: RoleHostObservation | null;
  readonly stopDisposition: RoleHostDisposition | null;
}

export function roleHostEventsAreOrdered(
  afterSequence: number,
  events: ReadonlyArray<RoleHostEvent>,
): string | null {
  let previous = afterSequence;
  for (const event of events) {
    if (event.sequence <= previous) {
      return `event sequence ${event.sequence} does not follow the recorded sequence ${previous}`;
    }
    previous = event.sequence;
  }
  return null;
}
