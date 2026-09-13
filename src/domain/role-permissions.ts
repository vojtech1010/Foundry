import { ROLE_HOST_ROLE_REQUIREMENTS } from './role-host.js';

import type {
  RoleHostRole,
  RoleHostNetworkProfile,
  RoleHostFilesystemProfile,
} from './role-host.js';

export const ROLE_PERMISSION_PROBLEM_KINDS = [
  'worktree-required',
  'runtime-origin-required',
  'invalid-runtime-origin',
  'invalid-environment-name',
] as const;

export type RolePermissionProblemKind = (typeof ROLE_PERMISSION_PROBLEM_KINDS)[number];

export interface RolePermissionProblem {
  readonly kind: RolePermissionProblemKind;
  readonly detail: string;
}

/**
 * Run-owned locations from which a role's host access scope is derived. A
 * caller never supplies permissions directly; it supplies where the run owns
 * resources and Foundry computes the closed access scope for the role.
 */
export interface RoleTurnLocations {
  readonly projectRoot: string;
  readonly runDirectory: string;
  readonly scratchDirectory: string;
  readonly worktree: string | null;
  readonly runtimeBaseUrl: string | null;
}

export interface RoleHostAccessScope {
  readonly role: RoleHostRole;
  readonly workingDirectory: string;
  readonly readRoots: ReadonlyArray<string>;
  readonly writeRoots: ReadonlyArray<string>;
  readonly networkAllowlist: ReadonlyArray<string>;
  readonly filesystem: ReadonlyArray<RoleHostFilesystemProfile>;
  readonly network: ReadonlyArray<RoleHostNetworkProfile>;
  readonly projectRoot: string;
  readonly runDirectory: string;
  readonly scratchDirectory: string;
  readonly worktree: string | null;
}

export type RoleHostAccessScopeEvaluation =
  | { readonly ok: true; readonly scope: RoleHostAccessScope }
  | { readonly ok: false; readonly problem: RolePermissionProblem };

export const ROLE_HOST_ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function isValidRoleHostEnvironmentName(name: string): boolean {
  return ROLE_HOST_ENVIRONMENT_NAME_PATTERN.test(name);
}

export function runtimeOriginOf(runtimeBaseUrl: string): string | null {
  try {
    const url = new URL(runtimeBaseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Derives the exact role-host access scope from run-owned locations. Fails
 * closed when a required bound cannot be established rather than falling back
 * to a wider permission set.
 */
export function deriveRoleHostAccessScope(
  role: RoleHostRole,
  locations: RoleTurnLocations,
): RoleHostAccessScopeEvaluation {
  const requirement = ROLE_HOST_ROLE_REQUIREMENTS[role];
  const scratch = locations.scratchDirectory;
  const worktree = locations.worktree;

  let readRoots: ReadonlyArray<string>;
  let writeRoots: ReadonlyArray<string>;
  let workingDirectory: string;

  if (role === 'coder' || role === 'lead_coder') {
    if (worktree === null || worktree.length === 0) {
      return {
        ok: false,
        problem: {
          kind: 'worktree-required',
          detail: `Role "${role}" requires a run-owned worktree, and none is available.`,
        },
      };
    }
    workingDirectory = worktree;
    readRoots = [worktree, locations.runDirectory];
    writeRoots = [worktree, scratch];
  } else {
    workingDirectory = locations.projectRoot;
    readRoots = [locations.projectRoot, locations.runDirectory];
    writeRoots = [scratch];
  }

  let networkAllowlist: ReadonlyArray<string> = [];
  if (role === 'tester') {
    if (locations.runtimeBaseUrl === null) {
      return {
        ok: false,
        problem: {
          kind: 'runtime-origin-required',
          detail: 'Tester requires the prepared application origin, and none is available.',
        },
      };
    }
    const origin = runtimeOriginOf(locations.runtimeBaseUrl);
    if (origin === null) {
      return {
        ok: false,
        problem: {
          kind: 'invalid-runtime-origin',
          detail: `The prepared application base URL "${locations.runtimeBaseUrl}" is not a usable HTTP origin.`,
        },
      };
    }
    networkAllowlist = [origin];
  }

  return {
    ok: true,
    scope: {
      role,
      workingDirectory,
      readRoots,
      writeRoots,
      networkAllowlist,
      filesystem: requirement.filesystem,
      network: requirement.network,
      projectRoot: locations.projectRoot,
      runDirectory: locations.runDirectory,
      scratchDirectory: scratch,
      worktree,
    },
  };
}

/**
 * Returns every problem with an environment allowlist. Values are never read
 * here; only names are validated because only names are ever forwarded.
 */
export function environmentAllowlistProblems(
  names: ReadonlyArray<string>,
): ReadonlyArray<RolePermissionProblem> {
  const problems: Array<RolePermissionProblem> = [];
  for (const name of names) {
    if (!isValidRoleHostEnvironmentName(name)) {
      problems.push({
        kind: 'invalid-environment-name',
        detail: `"${name}" is not a valid environment-variable name.`,
      });
    }
  }
  return problems;
}
