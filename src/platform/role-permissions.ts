import { spawnSync } from 'node:child_process';
import { Effect, Layer } from 'effect';

import { RoleTurnResourceObserver } from '../application/role-permissions/index.js';

import type { RoleHostAccessScope } from '../domain/role-permissions.js';
import type { RoleTurnResourceFingerprint } from '../application/role-permissions/index.js';

function gitStatus(directory: string): string {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    return 'unavailable';
  }
  return result.stdout;
}

function fingerprint(scope: RoleHostAccessScope): RoleTurnResourceFingerprint {
  return {
    projectStatus: gitStatus(scope.projectRoot),
    worktreeStatus: scope.worktree === null ? null : gitStatus(scope.worktree),
  };
}

export const RoleTurnResourceObserverLive: Layer.Layer<RoleTurnResourceObserver> = Layer.succeed(
  RoleTurnResourceObserver,
  RoleTurnResourceObserver.of({
    fingerprint: (scope) => Effect.sync(() => fingerprint(scope)),
  }),
);
