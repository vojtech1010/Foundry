import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';

import { RoleTurnResourceObserver } from '../application/role-permissions/index.js';

import type { RoleHostAccessScope } from '../domain/role-permissions.js';
import type { RoleTurnResourceFingerprint } from '../application/role-permissions/index.js';

const MAX_DEPTH = 6;

const FOUNDRY_OWNED_RUN_FILES: ReadonlySet<string> = new Set([
  'events.jsonl',
  'events.jsonl.lock',
  'events.witness.json',
  'workflow-state.json',
  'cleanup-progress.json',
  'run-state.json',
  'run-identity.json',
]);

function gitStatus(directory: string): string {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: directory, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    return 'unavailable';
  }
  return result.stdout;
}

function listOwnedResources(root: string, depth: number, prefix: string): Array<string> {
  if (depth > MAX_DEPTH) {
    return [];
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [`${prefix}<missing>`];
  }
  const lines: Array<string> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (FOUNDRY_OWNED_RUN_FILES.has(entry.name)) {
      continue;
    }
    const path = join(root, entry.name);
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      lines.push(`${relative}/`);
      lines.push(...listOwnedResources(path, depth + 1, relative));
    } else {
      let size = 'unknown';
      try {
        size = String(statSync(path).size);
      } catch {
        size = 'unreadable';
      }
      lines.push(`${relative}|${size}`);
    }
  }
  return lines;
}

function ownedResourceFingerprint(scope: RoleHostAccessScope): string {
  const lines = [
    ...listOwnedResources(scope.scratchDirectory, 0, 'scratch'),
    ...listOwnedResources(scope.runDirectory, 0, 'run'),
  ];
  return lines.join('\n');
}

function fingerprint(scope: RoleHostAccessScope): RoleTurnResourceFingerprint {
  return {
    projectStatus: gitStatus(scope.projectRoot),
    worktreeStatus: scope.worktree === null ? null : gitStatus(scope.worktree),
    ownedResources: ownedResourceFingerprint(scope),
  };
}

export const RoleTurnResourceObserverLive: Layer.Layer<RoleTurnResourceObserver> = Layer.succeed(
  RoleTurnResourceObserver,
  RoleTurnResourceObserver.of({
    fingerprint: (scope) => Effect.sync(() => fingerprint(scope)),
  }),
);
