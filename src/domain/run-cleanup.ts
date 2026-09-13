import { Schema } from 'effect';

import type { CleanupOutcome } from './workflow.js';

export const RUN_CLEANUP_RESOURCE_KINDS = [
  'runtime',
  'role-session',
  'workspace',
  'worker-worktree',
] as const;

export type RunCleanupResourceKind = (typeof RUN_CLEANUP_RESOURCE_KINDS)[number];

export const RUN_CLEANUP_DISPOSITIONS = ['disposed', 'skipped', 'pending', 'failed'] as const;

export type RunCleanupDisposition = (typeof RUN_CLEANUP_DISPOSITIONS)[number];

export const RunCleanupResourceSchema = Schema.Struct({
  kind: Schema.Literals(RUN_CLEANUP_RESOURCE_KINDS),
  name: Schema.NonEmptyString,
  disposition: Schema.Literals(RUN_CLEANUP_DISPOSITIONS),
});

export type RunCleanupResource = (typeof RunCleanupResourceSchema)['Type'];

export const RUN_CLEANUP_DETAIL_LIMIT = 500;

const DISPOSITION_TEXT: Readonly<Record<RunCleanupDisposition, string>> = {
  disposed: 'disposed',
  skipped: 'not owned',
  pending: 'disposal pending',
  failed: 'disposal failed',
};

export function describeRunCleanupResource(resource: RunCleanupResource): string {
  return `${resource.kind} "${resource.name}" ${DISPOSITION_TEXT[resource.disposition]}`;
}

/**
 * The durable `cleanup-progress` detail names every resource and its
 * disposition. It never claims a task branch was deleted; releasing a process,
 * session, or worktree is not proof that the branch is gone.
 */
export function describeRunCleanupReport(resources: ReadonlyArray<RunCleanupResource>): string {
  if (resources.length === 0) {
    return 'No run-owned resources required disposal.';
  }
  return resources.map(describeRunCleanupResource).join('; ').slice(0, RUN_CLEANUP_DETAIL_LIMIT);
}

export function cleanupOutcomeOf(resources: ReadonlyArray<RunCleanupResource>): CleanupOutcome {
  if (resources.some((resource) => resource.disposition === 'failed')) {
    return 'failed';
  }
  if (resources.some((resource) => resource.disposition === 'pending')) {
    return 'warning';
  }
  return 'succeeded';
}
