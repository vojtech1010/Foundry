import { Context, Effect, Exit, Schema } from 'effect';

import {
  deriveRoleHostAccessScope,
  environmentAllowlistProblems,
} from '../../domain/role-permissions.js';
import { appendRunEvent } from '../run-history/index.js';
import { startOrResumeRoleTurn } from '../role-conversations/index.js';

import type {
  RoleHostAccessScope,
  RolePermissionProblemKind,
  RoleTurnLocations,
} from '../../domain/role-permissions.js';
import type { RoleHostRole } from '../../domain/role-host.js';
import type { RolePermissionViolationKind } from '../../domain/run-history.js';

import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';
import type {
  RoleConversationError,
  RoleHost,
  RoleHostOperationalError,
  SettledRoleTurnResult,
} from '../role-conversations/index.js';

export const ROLE_TURN_PERMISSION_FAILURE_REASONS = [
  'worktree-required',
  'runtime-origin-required',
  'invalid-runtime-origin',
  'invalid-environment-name',
  'missing-enforcement',
  'project-mutation',
  'run-resource-mutation',
  'observe-failed',
] as const;

export type RoleTurnPermissionFailureReason = (typeof ROLE_TURN_PERMISSION_FAILURE_REASONS)[number];

export class RolePermissionViolation extends Schema.TaggedError<RolePermissionViolation>()(
  'RolePermissionViolation',
  {
    message: Schema.String,
    reason: Schema.Literals(ROLE_TURN_PERMISSION_FAILURE_REASONS),
    role: Schema.String,
    runId: Schema.String,
  },
) {}

export class RoleTurnResourceObserver extends Context.Service<
  RoleTurnResourceObserver,
  {
    readonly fingerprint: (
      scope: RoleHostAccessScope,
    ) => Effect.Effect<RoleTurnResourceFingerprint, RolePermissionObserveError>;
  }
>()('foundry/application/role-permissions/Observer') {}

export class RolePermissionObserveError extends Schema.TaggedError<RolePermissionObserveError>()(
  'RolePermissionObserveError',
  {
    message: Schema.String,
  },
) {}

export interface RoleTurnResourceFingerprint {
  readonly projectStatus: string;
  readonly worktreeStatus: string | null;
  readonly ownedResources: string;
}

const OBSERVATION_REASONS: Readonly<
  Record<RolePermissionProblemKind, RoleTurnPermissionFailureReason>
> = {
  'worktree-required': 'worktree-required',
  'runtime-origin-required': 'runtime-origin-required',
  'invalid-runtime-origin': 'invalid-runtime-origin',
  'invalid-environment-name': 'invalid-environment-name',
};

function isReadOnlyRole(role: RoleHostRole): boolean {
  return role !== 'coder' && role !== 'lead_coder';
}

function projectStateChanged(
  left: RoleTurnResourceFingerprint,
  right: RoleTurnResourceFingerprint,
): boolean {
  return left.projectStatus !== right.projectStatus || left.worktreeStatus !== right.worktreeStatus;
}

export interface RecordRolePermissionViolationOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly role: RoleHostRole;
  readonly attempt: number;
  readonly kind: RolePermissionViolationKind;
  readonly detail: string;
}

export const recordRolePermissionViolation = Effect.fn('recordRolePermissionViolation')(function* (
  options: RecordRolePermissionViolationOptions,
): Effect.fn.Return<void, RunHistoryError, RunHistoryStorage> {
  yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'role-permission-violation',
        payload: {
          role: options.role,
          attempt: options.attempt,
          kind: options.kind,
          detail: options.detail,
        },
      } as const),
  });
});

export interface StartGovernedRoleTurnOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly role: RoleHostRole;
  readonly attempt: number;
  readonly generation: number;
  readonly locations: RoleTurnLocations;
  readonly environmentAllowlist: ReadonlyArray<string>;
  readonly prompt: string;
  readonly deadline: string;
  readonly pollMs: number;
  readonly turnTimeoutMs: number;
}

/**
 * Runs one role turn with the access scope derived from run-owned locations
 * rather than caller-chosen permissions. It fails closed when the host cannot
 * be bounded, and it compares the project and worktree state before and after
 * every read-only turn (including failures and resumed turns) as a second
 * detection layer. A detected mutation is recorded and the attempt stops.
 */
export const startGovernedRoleTurn = Effect.fn('startGovernedRoleTurn')(function* (
  options: StartGovernedRoleTurnOptions,
): Effect.fn.Return<
  SettledRoleTurnResult,
  | RolePermissionViolation
  | RolePermissionObserveError
  | RoleConversationError
  | RoleHostOperationalError
  | RunHistoryError,
  RoleHost | RunHistoryStorage | RoleTurnResourceObserver
> {
  const environmentProblems = environmentAllowlistProblems(options.environmentAllowlist);
  if (environmentProblems.length > 0) {
    return yield* new RolePermissionViolation({
      message: `Run "${options.runId}" cannot start role "${options.role}": ${environmentProblems
        .map((problem) => problem.detail)
        .join(' ')}`,
      reason: 'invalid-environment-name',
      role: options.role,
      runId: options.runId,
    });
  }

  const derived = deriveRoleHostAccessScope(options.role, options.locations);
  if (!derived.ok) {
    const detail = derived.problem.detail;
    yield* recordRolePermissionViolation({
      runDirectory: options.runDirectory,
      runId: options.runId,
      role: options.role,
      attempt: options.attempt,
      kind: 'missing-enforcement',
      detail,
    });
    return yield* new RolePermissionViolation({
      message: `Run "${options.runId}" cannot enforce the "${options.role}" permission profile: ${detail}`,
      reason: OBSERVATION_REASONS[derived.problem.kind],
      role: options.role,
      runId: options.runId,
    });
  }

  const scope = derived.scope;
  const observer = yield* RoleTurnResourceObserver;
  const readOnly = isReadOnlyRole(options.role);
  const before = readOnly ? yield* observer.fingerprint(scope) : null;

  const attempt = yield* Effect.exit(
    startOrResumeRoleTurn({
      runDirectory: options.runDirectory,
      runId: options.runId,
      role: options.role,
      attempt: options.attempt,
      generation: options.generation,
      prompt: options.prompt,
      deadline: options.deadline,
      pollMs: options.pollMs,
      turnTimeoutMs: options.turnTimeoutMs,
      locations: options.locations,
    }),
  );

  if (readOnly && before !== null) {
    const after = yield* observer.fingerprint(scope);
    if (projectStateChanged(before, after)) {
      const detail = `Role "${options.role}" turn for run "${options.runId}" changed the project or worktree state while read-only.`;
      yield* recordRolePermissionViolation({
        runDirectory: options.runDirectory,
        runId: options.runId,
        role: options.role,
        attempt: options.attempt,
        kind: 'project-mutation',
        detail,
      });
      return yield* new RolePermissionViolation({
        message: detail,
        reason: 'project-mutation',
        role: options.role,
        runId: options.runId,
      });
    }
    if (before.ownedResources !== after.ownedResources) {
      const detail = `Role "${options.role}" turn for run "${options.runId}" changed run-owned resources while read-only.`;
      yield* recordRolePermissionViolation({
        runDirectory: options.runDirectory,
        runId: options.runId,
        role: options.role,
        attempt: options.attempt,
        kind: 'run-resource-mutation',
        detail,
      });
      return yield* new RolePermissionViolation({
        message: detail,
        reason: 'run-resource-mutation',
        role: options.role,
        runId: options.runId,
      });
    }
  }

  if (Exit.isFailure(attempt)) {
    return yield* Effect.failCause(attempt.cause);
  }
  return attempt.value;
});
