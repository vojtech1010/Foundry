import { DateTime, Effect, Option, Result, Schema } from 'effect';
import { dirname, join, resolve } from 'node:path';

import { workerBranchName, workerWorkspacePath } from '../../domain/parallel-workers.js';
import { RUN_STORAGE_DIRECTORY_NAME } from '../../domain/readiness.js';
import {
  CLEANUP_GUIDANCE,
  RETENTION_CLEANUP_SCHEMA_VERSION,
  cleanupRunOutcomeOf,
  evaluateRetentionWindow,
} from '../../domain/retention-cleanup.js';
import { Identifier, REQUEST_IDENTITY_FILENAME } from '../../domain/run-identity.js';
import { RUNS_DIRECTORY_NAME, isPathInside } from '../../domain/run-locations.js';
import { isTerminalWorkflowState } from '../../domain/workflow.js';
import { RunGit } from '../git-provisioning/index.js';
import { HANDOFF_FILENAME } from '../handoff/index.js';
import { decodeProjectConfiguration } from '../project-configuration.js';
import { ReadinessFiles } from '../readiness/index.js';
import { RoleHostLauncher, stopRoleSession } from '../role-conversations/index.js';
import { readVerifiedRunHistory } from '../run-history/index.js';
import { RunIdentityStore, readRetainedRunIdentity } from '../run-identity/index.js';

import type {
  CleanupCheckReport,
  CleanupEligibleRun,
  CleanupListReport,
  CleanupPreserved,
  CleanupResourceReport,
  CleanupRunReport,
  RetentionOwnershipState,
} from '../../domain/retention-cleanup.js';
import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type { RunEvent, RunHistoryDerivedState } from '../../domain/run-history.js';
import type { RequestIdentityDocument } from '../../domain/run-identity.js';
import type { WorkflowState } from '../../domain/workflow.js';
import type { RunHistoryStorage } from '../run-history/index.js';
import type { ReadinessError } from '../readiness/index.js';

export const CLEANUP_ERROR_REASONS = [
  'configuration',
  'confirm-mismatch',
  'invalid-run',
  'storage',
  'history',
  'nonterminal',
  'within-retention',
  'uncertain',
  'check-failed',
] as const;

export type CleanupErrorReason = (typeof CLEANUP_ERROR_REASONS)[number];

export class RetentionCleanupError extends Schema.TaggedError<RetentionCleanupError>()(
  'RetentionCleanupError',
  {
    message: Schema.String,
    kind: Schema.Literals(['blocked', 'failed']),
    reason: Schema.Literals(CLEANUP_ERROR_REASONS),
    runId: Schema.optional(Schema.String),
    check: Schema.optional(Schema.String),
  },
) {}

export interface RetentionCleanupListOptions {
  readonly configArg: string;
  readonly cwd: string;
}

export interface RetentionCleanupRunOptions extends RetentionCleanupListOptions {
  readonly runId: string;
  readonly confirm: string;
}

function excerpt(output: string): string {
  return output.trim().replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

function runsRootOf(configuration: ProjectConfiguration): string {
  return join(configuration.targetRepository, RUN_STORAGE_DIRECTORY_NAME, RUNS_DIRECTORY_NAME);
}

function instantMillis(instant: string): number | null {
  const parsed = DateTime.make(instant);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : null;
}

function terminalTransitionOf(
  events: ReadonlyArray<RunEvent>,
): { readonly state: WorkflowState; readonly occurredAt: string } | null {
  let found: { readonly state: WorkflowState; readonly occurredAt: string } | null = null;
  for (const event of events) {
    if (event.type === 'workflow-transition' && isTerminalWorkflowState(event.payload.to)) {
      found = { state: event.payload.to, occurredAt: event.occurredAt };
    }
  }
  return found;
}

function ownershipOf(
  identity: RequestIdentityDocument | null,
  runId: string,
): RetentionOwnershipState {
  return identity !== null && identity.runId === runId ? 'owned' : 'uncertain';
}

function taskBranchOf(derived: RunHistoryDerivedState): string | null {
  return derived.worktreeReady?.taskBranch ?? derived.sourceFrozen?.taskBranch ?? null;
}

const readConfiguration = Effect.fn('retentionCleanup.readConfiguration')(function* (
  options: RetentionCleanupListOptions,
  runId: string | undefined,
): Effect.fn.Return<ProjectConfiguration, RetentionCleanupError, ReadinessFiles> {
  const files = yield* ReadinessFiles;
  const configPath = resolve(options.cwd, options.configArg);
  const configText = yield* files.readFile(configPath).pipe(
    Effect.mapError(
      (error: ReadinessError) =>
        new RetentionCleanupError({
          message: `Cannot read configuration document at ${configPath}: ${excerpt(error.message)}.`,
          kind: 'failed',
          reason: 'configuration',
          runId,
        }),
    ),
  );
  const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
    configText,
  ).pipe(
    Effect.mapError(
      (error) =>
        new RetentionCleanupError({
          message: `Configuration document at ${configPath} is not valid JSON: ${excerpt(error.message)}.`,
          kind: 'failed',
          reason: 'configuration',
          runId,
        }),
    ),
  );
  return yield* decodeProjectConfiguration(document, dirname(configPath)).pipe(
    Effect.mapError(
      (error) =>
        new RetentionCleanupError({
          message: error.message,
          kind: 'failed',
          reason: 'configuration',
          runId,
        }),
    ),
  );
});

export const readRetentionCleanupList = Effect.fn('readRetentionCleanupList')(function* (
  options: RetentionCleanupListOptions,
): Effect.fn.Return<
  CleanupListReport,
  RetentionCleanupError,
  ReadinessFiles | RunIdentityStore | RunHistoryStorage
> {
  const configuration = yield* readConfiguration(options, undefined);
  const store = yield* RunIdentityStore;
  const runsRoot = runsRootOf(configuration);
  const ids = yield* store.listRuns(runsRoot).pipe(
    Effect.mapError(
      (error) =>
        new RetentionCleanupError({
          message: error.message,
          kind: 'failed',
          reason: 'storage',
        }),
    ),
  );
  const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
  const retentionDays = configuration.artifacts.retentionDays;
  const runs: Array<CleanupEligibleRun> = [];

  for (const runId of ids) {
    if (!Schema.is(Identifier)(runId)) {
      continue;
    }
    const runDirectory = join(runsRoot, runId);
    const history = yield* readVerifiedRunHistory({
      runDirectory,
      runId,
      createIfMissing: false,
    }).pipe(Effect.result);
    if (Result.isFailure(history)) {
      continue;
    }
    const derived = history.success.derived;
    const terminal = terminalTransitionOf(history.success.events);
    const window = evaluateRetentionWindow({
      state: derived.state,
      terminalAtMillis: terminal === null ? null : instantMillis(terminal.occurredAt),
      nowMillis,
      retentionDays,
    });
    if (window.eligibility !== 'eligible' || terminal === null || window.ageMs === null) {
      continue;
    }
    const identity = yield* readRetainedRunIdentity(
      store,
      join(runDirectory, REQUEST_IDENTITY_FILENAME),
      runId,
    ).pipe(Effect.result);
    const document = Result.isSuccess(identity) ? identity.success : null;
    runs.push({
      runId,
      taskId: document?.taskId ?? null,
      workflowState: terminal.state,
      terminalAt: terminal.occurredAt,
      retentionDays,
      ageMs: window.ageMs,
      ownership: ownershipOf(document, runId),
      taskBranch: taskBranchOf(derived),
      cleanupOutcome: derived.cleanupProgress?.outcome ?? null,
    });
  }

  return {
    schemaVersion: RETENTION_CLEANUP_SCHEMA_VERSION,
    retentionDays,
    runs,
    guidance: CLEANUP_GUIDANCE,
  };
});

interface CleanupCheckOptions {
  readonly configuration: ProjectConfiguration;
  readonly runDirectory: string;
  readonly runId: string;
  readonly derived: RunHistoryDerivedState;
}

const runCleanupChecks = Effect.fn('retentionCleanup.runChecks')(function* (
  options: CleanupCheckOptions,
): Effect.fn.Return<ReadonlyArray<CleanupCheckReport>, never, RunGit | RunIdentityStore> {
  const { configuration, runDirectory, runId, derived } = options;
  const checks: Array<CleanupCheckReport> = [];

  checks.push({
    check: 'state',
    ok: derived.state !== null && isTerminalWorkflowState(derived.state),
    detail: `Recorded workflow state is ${derived.state ?? 'unknown'}.`,
  });
  checks.push({
    check: 'history',
    ok: true,
    detail: 'Verified run history was read successfully.',
  });

  const workers = derived.objectiveWorkers ?? [];
  const undisposed = workers.filter(
    (record) =>
      record.phase === 'created' &&
      !workers.some(
        (candidate) => candidate.sessionId === record.sessionId && candidate.phase === 'disposed',
      ),
  );
  checks.push({
    check: 'workers',
    ok: undisposed.length === 0,
    detail:
      undisposed.length === 0
        ? workers.length === 0
          ? 'No parallel worker session is recorded.'
          : 'Every recorded worker session is disposed.'
        : `Worker sessions remain undisposed: ${undisposed.map((record) => record.sessionId).join(', ')}.`,
  });

  const workspace = derived.worktreeReady?.workspace;
  const workspacePaths: Array<string> = [];
  if (workspace !== undefined) {
    workspacePaths.push(workspace);
    for (const record of workers) {
      workspacePaths.push(workerWorkspacePath(workspace, record.objectiveId, runId));
    }
  }
  const escaping = workspacePaths.filter(
    (path) => !isPathInside(configuration.targetRepository, path),
  );
  checks.push({
    check: 'workspaces',
    ok: escaping.length === 0,
    detail:
      escaping.length === 0
        ? 'Every recorded workspace is inside the target repository.'
        : `Recorded workspaces escape the target repository: ${escaping.join(', ')}.`,
  });

  const git = yield* RunGit;
  const taskBranch = taskBranchOf(derived);
  const branchProblems: Array<string> = [];
  if (taskBranch !== null) {
    const observation = yield* git
      .readBranch({ repositoryRoot: configuration.targetRepository, branch: taskBranch, runId })
      .pipe(Effect.result);
    if (Result.isFailure(observation)) {
      branchProblems.push(`the task branch "${taskBranch}" could not be read`);
    }
  }
  if (taskBranch !== null) {
    for (const record of workers) {
      if (record.phase !== 'settled' || record.commit === null) {
        continue;
      }
      const branch = workerBranchName(taskBranch, record.objectiveId, runId);
      const observation = yield* git
        .readBranch({ repositoryRoot: configuration.targetRepository, branch, runId })
        .pipe(Effect.result);
      if (Result.isFailure(observation)) {
        branchProblems.push(`worker branch "${branch}" could not be read`);
      } else if (observation.success.exists && observation.success.commit !== record.commit) {
        branchProblems.push(
          `worker branch "${branch}" is at ${observation.success.commit ?? 'an unknown commit'} instead of its recorded commit`,
        );
      }
    }
  }
  checks.push({
    check: 'branches',
    ok: branchProblems.length === 0,
    detail:
      branchProblems.length === 0
        ? 'The task branch and every recorded worker branch match their durable run ownership.'
        : branchProblems.join('; '),
  });

  const store = yield* RunIdentityStore;
  const identity = yield* readRetainedRunIdentity(
    store,
    join(runDirectory, REQUEST_IDENTITY_FILENAME),
    runId,
  ).pipe(Effect.result);
  const owned = Result.isSuccess(identity) && identity.success !== null;
  const provenancePresent = derived.sourceFrozen !== null && derived.worktreeReady !== null;
  checks.push({
    check: 'ownership',
    ok: owned && provenancePresent,
    detail:
      owned && provenancePresent
        ? 'Retained run identity and provisioning provenance confirm run ownership.'
        : 'Retained run identity or provisioning provenance is missing or does not match this run.',
  });

  return checks;
});

type DisposeOptions = CleanupCheckOptions;

const stopRecordedSessions = Effect.fn('retentionCleanup.stopSessions')(function* (
  options: DisposeOptions,
): Effect.fn.Return<
  ReadonlyArray<CleanupResourceReport>,
  never,
  RoleHostLauncher | RunHistoryStorage
> {
  const sessions = options.derived.roleSessions;
  if (sessions.length === 0) {
    return [];
  }
  const launcher = yield* RoleHostLauncher;
  const hostLayer = launcher.launch({
    command: options.configuration.roleHarness.command,
    cwd: options.configuration.targetRepository,
    environmentAllowlist: options.configuration.roleHarness.environmentAllowlist,
    timeoutMs: options.configuration.timeouts.commandMs,
    maxOutputBytes: options.configuration.artifacts.maxRoleHandoffBytes,
  });
  const resources: Array<CleanupResourceReport> = [];
  for (const session of sessions) {
    if (session.stopDisposition !== null) {
      resources.push({
        kind: 'role-session',
        name: session.sessionId,
        disposition: 'disposed',
      });
      continue;
    }
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

const disposeDirectories = Effect.fn('retentionCleanup.disposeDirectories')(function* (
  directories: ReadonlyArray<{
    readonly kind: 'workspace' | 'worker-worktree';
    readonly name: string;
    readonly path: string;
  }>,
): Effect.fn.Return<ReadonlyArray<CleanupResourceReport>, never, RunIdentityStore> {
  if (directories.length === 0) {
    return [];
  }
  const store = yield* RunIdentityStore;
  const resources: Array<CleanupResourceReport> = [];
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

const disposeEvidence = Effect.fn('retentionCleanup.disposeEvidence')(function* (
  path: string,
): Effect.fn.Return<CleanupResourceReport, never, RunIdentityStore> {
  const store = yield* RunIdentityStore;
  const removed = yield* store.removeDirectory(path).pipe(Effect.result);
  return {
    kind: 'evidence',
    name: path,
    disposition: Result.isSuccess(removed) ? 'disposed' : 'failed',
  };
});

const disposeRetentionResources = Effect.fn('retentionCleanup.dispose')(function* (
  options: DisposeOptions,
): Effect.fn.Return<
  ReadonlyArray<CleanupResourceReport>,
  never,
  RoleHostLauncher | RunHistoryStorage | RunIdentityStore
> {
  const resources: Array<CleanupResourceReport> = [];
  resources.push(...(yield* stopRecordedSessions(options)));

  const workspace = options.derived.worktreeReady?.workspace;
  const directories: Array<{
    readonly kind: 'workspace' | 'worker-worktree';
    readonly name: string;
    readonly path: string;
  }> = [];
  if (workspace === undefined) {
    resources.push({ kind: 'workspace', name: 'run-worktree', disposition: 'skipped' });
  } else {
    directories.push({ kind: 'workspace', name: workspace, path: workspace });
    const seen = new Set<string>();
    for (const record of options.derived.objectiveWorkers ?? []) {
      const path = workerWorkspacePath(workspace, record.objectiveId, options.runId);
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      directories.push({ kind: 'worker-worktree', name: path, path });
    }
  }
  resources.push(...(yield* disposeDirectories(directories)));
  resources.push(yield* disposeEvidence(join(options.runDirectory, 'evidence')));
  return resources;
});

function cleanupMessage(
  runId: string,
  outcome: CleanupRunReport['outcome'],
  resources: ReadonlyArray<CleanupResourceReport>,
): string {
  const disposed = resources.filter((resource) => resource.disposition === 'disposed').length;
  const failed = resources.filter((resource) => resource.disposition === 'failed').length;
  const pending = resources.filter((resource) => resource.disposition === 'pending').length;
  return `Retention cleanup for run "${runId}" ${outcome}, disposing ${disposed} resource(s)${failed === 0 ? '' : `; ${failed} failed`}${pending === 0 ? '' : `; ${pending} pending`}. The task branch and canonical handoff were preserved.`;
}

export const runRetentionCleanup = Effect.fn('runRetentionCleanup')(function* (
  options: RetentionCleanupRunOptions,
): Effect.fn.Return<
  CleanupRunReport,
  RetentionCleanupError,
  ReadinessFiles | RunIdentityStore | RunHistoryStorage | RunGit | RoleHostLauncher
> {
  const runId = options.runId;
  if (!Schema.is(Identifier)(runId)) {
    return yield* new RetentionCleanupError({
      message: `Run ID "${options.runId}" is not a valid run identifier.`,
      kind: 'failed',
      reason: 'invalid-run',
      runId: options.runId,
    });
  }
  if (options.confirm !== runId) {
    return yield* new RetentionCleanupError({
      message: 'Value for --confirm must match --run-id.',
      kind: 'blocked',
      reason: 'confirm-mismatch',
      runId,
    });
  }

  const configuration = yield* readConfiguration(options, runId);
  const runDirectory = join(runsRootOf(configuration), runId);
  const history = yield* readVerifiedRunHistory({
    runDirectory,
    runId,
    createIfMissing: false,
  }).pipe(
    Effect.mapError(
      (error) =>
        new RetentionCleanupError({
          message: error.message,
          kind: 'failed',
          reason: 'history',
          runId,
        }),
    ),
  );
  const derived = history.derived;
  if (derived.state === null || !isTerminalWorkflowState(derived.state)) {
    return yield* new RetentionCleanupError({
      message: `Run "${runId}" is not in a terminal state and is never eligible for retention cleanup; no file was written.`,
      kind: 'blocked',
      reason: 'nonterminal',
      runId,
      check: 'state',
    });
  }

  const terminal = terminalTransitionOf(history.events);
  const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
  const window = evaluateRetentionWindow({
    state: derived.state,
    terminalAtMillis: terminal === null ? null : instantMillis(terminal.occurredAt),
    nowMillis,
    retentionDays: configuration.artifacts.retentionDays,
  });
  if (window.eligibility !== 'eligible') {
    return yield* new RetentionCleanupError({
      message: `Run "${runId}" is ${
        window.eligibility === 'within-retention'
          ? 'still inside its retention window'
          : `not verifiably eligible (${window.eligibility})`
      }; no file was written.`,
      kind: 'blocked',
      reason: window.eligibility === 'within-retention' ? 'within-retention' : 'uncertain',
      runId,
    });
  }

  const checkOptions: CleanupCheckOptions = { configuration, runDirectory, runId, derived };
  const checks = yield* runCleanupChecks(checkOptions);
  const failed = checks.find((check) => !check.ok);
  if (failed !== undefined) {
    return yield* new RetentionCleanupError({
      message: `Run "${runId}" cannot be cleaned because the ${failed.check} check failed: ${failed.detail}`,
      kind: 'blocked',
      reason: 'check-failed',
      runId,
      check: failed.check,
    });
  }

  const resources = yield* disposeRetentionResources(checkOptions);
  const preserved: CleanupPreserved = {
    taskBranch: taskBranchOf(derived),
    handoffPath: join(runDirectory, HANDOFF_FILENAME),
  };
  const outcome = cleanupRunOutcomeOf(resources);
  return {
    schemaVersion: RETENTION_CLEANUP_SCHEMA_VERSION,
    runId,
    outcome,
    checks,
    resources,
    preserved,
    message: cleanupMessage(runId, outcome, resources),
  };
});
