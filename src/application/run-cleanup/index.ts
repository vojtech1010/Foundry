import { Effect, Result } from 'effect';

import { cleanupOutcomeOf } from '../../domain/run-cleanup.js';
import {
  RoleHostLauncher,
  launchOptionsForRole,
  stopRoleSession,
} from '../role-conversations/index.js';
import { readVerifiedRunHistory } from '../run-history/index.js';
import { RunIdentityStore } from '../run-identity/index.js';

import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type { RunCleanupResource } from '../../domain/run-cleanup.js';
import type { RunHistoryDerivedState } from '../../domain/run-history.js';
import type { CleanupOutcome } from '../../domain/workflow.js';
import type { HeldApplicationRuntime } from '../project-runtime/index.js';
import type { RunHistoryStorage } from '../run-history/index.js';

export interface WorkerWorktreeDisposal {
  readonly name: string;
  readonly workspace: string;
}

export interface DisposeRunResourcesOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly configuration: ProjectConfiguration;
  readonly runtime: HeldApplicationRuntime | null;
  readonly workerWorktrees?: ReadonlyArray<WorkerWorktreeDisposal>;
}

export interface DisposeRunResourcesReport {
  readonly outcome: CleanupOutcome;
  readonly resources: ReadonlyArray<RunCleanupResource>;
}

const runtimeResource = Effect.fn('disposeRunResources.runtime')(function* (
  runtime: HeldApplicationRuntime | null,
  lifecycles: RunHistoryDerivedState['runtimeLifecycles'],
) {
  const name = 'application-runtime';
  if (runtime !== null) {
    const disposed = yield* runtime.dispose.pipe(Effect.result);
    if (Result.isFailure(disposed)) {
      return { kind: 'runtime', name, disposition: 'failed' } satisfies RunCleanupResource;
    }
    return {
      kind: 'runtime',
      name,
      disposition: disposed.success.cleanup === 'failed' ? 'failed' : 'disposed',
    } satisfies RunCleanupResource;
  }
  if (lifecycles.some((record) => record.cleanup === 'failed')) {
    return { kind: 'runtime', name, disposition: 'failed' } satisfies RunCleanupResource;
  }
  if (lifecycles.length > 0) {
    return { kind: 'runtime', name, disposition: 'disposed' } satisfies RunCleanupResource;
  }
  return { kind: 'runtime', name, disposition: 'skipped' } satisfies RunCleanupResource;
});

const stopRoleSessions = Effect.fn('disposeRunResources.roleSessions')(function* (
  options: DisposeRunResourcesOptions,
  sessions: RunHistoryDerivedState['roleSessions'],
): Effect.fn.Return<
  ReadonlyArray<RunCleanupResource>,
  never,
  RoleHostLauncher | RunHistoryStorage
> {
  if (sessions.length === 0) {
    return [];
  }
  const launcher = yield* RoleHostLauncher;
  const resources: Array<RunCleanupResource> = [];
  for (const session of sessions) {
    if (session.stopDisposition !== null) {
      resources.push({
        kind: 'role-session',
        name: session.sessionId,
        disposition: 'disposed',
      });
      continue;
    }
    // Each recorded session stops through its own role's bundled harness.
    const hostLayer = launcher.launch(
      launchOptionsForRole({
        configuration: options.configuration,
        role: session.role,
        cwd: options.configuration.targetRepository,
      }),
    );
    const stopped = yield* stopRoleSession({
      runDirectory: options.runDirectory,
      runId: options.runId,
      role: session.role,
      attempt: session.attempt,
      generation: session.generation,
    }).pipe(Effect.provide(hostLayer), Effect.result);
    resources.push({
      kind: 'role-session',
      name: session.sessionId,
      disposition: Result.isSuccess(stopped) ? 'disposed' : 'pending',
    });
  }
  return resources;
});

const disposeDirectories = Effect.fn('disposeRunResources.directories')(function* (
  directories: ReadonlyArray<{
    readonly kind: 'workspace' | 'worker-worktree';
    readonly name: string;
    readonly path: string;
  }>,
): Effect.fn.Return<ReadonlyArray<RunCleanupResource>, never, RunIdentityStore> {
  if (directories.length === 0) {
    return [];
  }
  const store = yield* RunIdentityStore;
  const resources: Array<RunCleanupResource> = [];
  for (const directory of directories) {
    const removed = yield* store.removeDirectory(directory.path).pipe(Effect.result);
    resources.push({
      kind: directory.kind,
      name: directory.name,
      disposition: Result.isSuccess(removed) ? 'disposed' : 'failed',
    });
  }
  return resources;
});

/**
 * Releases the run-owned resources once a run reaches a terminal state: the
 * owned application process, every recorded role session, the run worktree, and
 * any worker worktrees recorded by a later objective. Problems are reported as
 * per-resource dispositions instead of failing the run, and the task branch is
 * never deleted. A run whose cleanup progress is already recorded is left
 * untouched so a resumed terminal run does not dispose twice.
 */
export const disposeRunResources = Effect.fn('disposeRunResources')(function* (
  options: DisposeRunResourcesOptions,
) {
  const read = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  }).pipe(Effect.result);
  if (Result.isFailure(read)) {
    const unreadable: RunCleanupResource = {
      kind: 'workspace',
      name: 'run-worktree',
      disposition: 'failed',
    };
    return { outcome: 'failed', resources: [unreadable] } satisfies DisposeRunResourcesReport;
  }
  const history = read.success;
  if (history.derived.cleanupProgress !== null) {
    return null;
  }

  const resources: Array<RunCleanupResource> = [];
  resources.push(yield* runtimeResource(options.runtime, history.derived.runtimeLifecycles));
  resources.push(...(yield* stopRoleSessions(options, history.derived.roleSessions)));

  const directories: Array<{
    readonly kind: 'workspace' | 'worker-worktree';
    readonly name: string;
    readonly path: string;
  }> = [];
  const workspace = history.derived.worktreeReady?.workspace;
  if (workspace !== undefined) {
    directories.push({ kind: 'workspace', name: workspace, path: workspace });
  } else {
    resources.push({ kind: 'workspace', name: 'run-worktree', disposition: 'skipped' });
  }
  for (const worker of options.workerWorktrees ?? []) {
    directories.push({ kind: 'worker-worktree', name: worker.name, path: worker.workspace });
  }
  resources.push(...(yield* disposeDirectories(directories)));

  return { outcome: cleanupOutcomeOf(resources), resources } satisfies DisposeRunResourcesReport;
});
