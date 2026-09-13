import { Context, Effect, Result, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { RUN_STORAGE_DIRECTORY_NAME } from '../../domain/readiness.js';
import {
  RUNS_DIRECTORY_NAME,
  isLegalGitBranchName,
  isPathInside,
  renderTaskBranch,
  renderWorkspacePath,
} from '../../domain/run-locations.js';
import {
  Identifier,
  REQUEST_IDENTITY_FILENAME,
  REQUEST_IDENTITY_SCHEMA_VERSION,
  REQUEST_NORMALIZED_FILENAME,
  REQUEST_ORIGINAL_FILENAME,
  RequestIdentityDocumentSchema,
  normalizeRequestPromptText,
} from '../../domain/run-identity.js';
import {
  CLEANUP_PROGRESS_FILENAME,
  CLEANUP_PROGRESS_SCHEMA_VERSION,
  WORKFLOW_STATE_FILENAME,
  WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
  evaluateWorkflowTransition,
} from '../../domain/workflow.js';
import { RUN_HISTORY_FILENAME } from '../../domain/run-history.js';
import { decodeProjectConfiguration } from '../project-configuration.js';
import {
  RunWorkspaceBlocked,
  provisionRunSource,
  provisionRunWorktree,
} from '../git-provisioning/index.js';
import { ensureGuidanceSnapshot } from '../guidance/index.js';
import { ReadinessFiles } from '../readiness/index.js';
import { withRepositoryLease } from '../repository-lease/index.js';
import { preflightRoleHostCapabilities } from '../role-conversations/index.js';
import {
  RunHistoryConflict,
  RunHistoryStorage,
  appendRunEvent,
  readVerifiedRunHistory,
} from '../run-history/index.js';

import type {
  DerivedReportWrite,
  RunHistoryError,
  RunHistoryIntegrityError,
  RunHistoryStorageError,
} from '../run-history/index.js';
import type { GuidanceError } from '../guidance/index.js';
import type { GuidanceGit, GuidanceSnapshotStore } from '../guidance/index.js';
import type {
  RepositoryHostIdentity,
  RepositoryLeaseError,
  RepositoryLeaseStore,
} from '../repository-lease/index.js';
import type { RoleHostCapabilityError, RoleHostLauncher } from '../role-conversations/index.js';
import type {
  CleanupProgressPayload,
  RunEventDraft,
  RunHistoryDerivedState,
  SourceFrozenPayload,
  WorktreeReadyPayload,
} from '../../domain/run-history.js';
import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type { RequestIdentityDocument } from '../../domain/run-identity.js';
import type { RunGit } from '../git-provisioning/index.js';
import type {
  CleanupProgressDocument,
  WorkflowAttempt,
  WorkflowProgressDocument,
  WorkflowState,
} from '../../domain/workflow.js';

export class InvalidRunRequest extends Schema.TaggedError<InvalidRunRequest>()(
  'InvalidRunRequest',
  {
    message: Schema.String,
    runId: Schema.optional(Schema.String),
  },
) {}

export class DuplicateRunId extends Schema.TaggedError<DuplicateRunId>()('DuplicateRunId', {
  message: Schema.String,
  runId: Schema.String,
}) {}

export class RunIdentityStorageError extends Schema.TaggedError<RunIdentityStorageError>()(
  'RunIdentityStorageError',
  {
    message: Schema.String,
    runId: Schema.optional(Schema.String),
  },
) {}

export class RunStateUnavailable extends Schema.TaggedError<RunStateUnavailable>()(
  'RunStateUnavailable',
  {
    message: Schema.String,
    runId: Schema.String,
  },
) {}

export type RunIdentityError =
  | InvalidRunRequest
  | DuplicateRunId
  | RunIdentityStorageError
  | RunWorkspaceBlocked
  | RunHistoryError
  | GuidanceError
  | RoleHostCapabilityError
  | RepositoryLeaseError;

export interface RunStorageFileStatus {
  readonly exists: boolean;
  readonly isRegularFile: boolean;
}

export class RunIdentityStore extends Context.Service<
  RunIdentityStore,
  {
    readonly statPath: (
      path: string,
    ) => Effect.Effect<RunStorageFileStatus, RunIdentityStorageError>;
    readonly readFileBytes: (path: string) => Effect.Effect<Uint8Array, RunIdentityStorageError>;
    readonly ensureParentDirectory: (path: string) => Effect.Effect<void, RunIdentityStorageError>;
    readonly createRunDirectoryExclusive: (
      path: string,
      runId: string,
    ) => Effect.Effect<void, DuplicateRunId | RunIdentityStorageError>;
    readonly writeFileBytes: (
      path: string,
      bytes: Uint8Array,
    ) => Effect.Effect<void, RunIdentityStorageError>;
    readonly removeDirectory: (path: string) => Effect.Effect<void, RunIdentityStorageError>;
  }
>()('foundry/application/run-identity/Store') {}

export interface RecordedRequestFiles {
  readonly sourcePath: string;
  readonly originalPath: string;
  readonly normalizedPath: string;
  readonly identityPath: string;
  readonly originalByteLength: number;
  readonly originalContentHash: string;
  readonly normalizedByteLength: number;
  readonly normalizedPromptHash: string;
}

export interface RunProvenance {
  readonly repositoryRoot: string;
  readonly gitDirectory: string;
  readonly remoteUrl: string;
  readonly sourceRemote: string;
  readonly sourceBranch: string;
  readonly sourceCommit: string;
  readonly taskBranch: string;
  readonly workspace: string;
  readonly headCommit: string;
}

export interface RecordedRunIdentityReport {
  readonly runId: string;
  readonly taskId: string;
  readonly runDirectory: string;
  readonly request: RecordedRequestFiles;
  readonly provenance: RunProvenance;
}

export interface RecordRunIdentityOptions {
  readonly configArg: string;
  readonly cwd: string;
  readonly requestArg: string;
  readonly taskId: string;
  readonly runId: string;
}

export interface RunProgressReport {
  readonly runId: string;
  readonly runDirectory: string;
  readonly historyPath: string;
  readonly revision: number;
  readonly eventHash: string | null;
  readonly workflowState: WorkflowState;
  readonly checkpoint: WorkflowState | null;
  readonly attempts: ReadonlyArray<WorkflowAttempt>;
  readonly cleanupProgress: CleanupProgressPayload | null;
  readonly provenance: RunProvenance | null;
}

export interface ReadRunWorkflowStateOptions {
  readonly configArg: string;
  readonly cwd: string;
  readonly runId: string;
}

class RunConfigurationInvalid extends Schema.TaggedError<RunConfigurationInvalid>()(
  'RunConfigurationInvalid',
  {
    message: Schema.String,
  },
) {}

function excerpt(output: string): string {
  return output.trim().replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

function sha256HexOfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

function isRunIdentifier(value: string): boolean {
  return Schema.is(Identifier)(value);
}

function runDirectoryOf(configuration: ProjectConfiguration, runId: string): string {
  return join(
    configuration.targetRepository,
    RUN_STORAGE_DIRECTORY_NAME,
    RUNS_DIRECTORY_NAME,
    runId,
  );
}

const readRunConfiguration = Effect.fn('readRunConfiguration')(function* (
  configArg: string,
  cwd: string,
): Effect.fn.Return<ProjectConfiguration, RunConfigurationInvalid, ReadinessFiles> {
  const files = yield* ReadinessFiles;
  const configPath = resolve(cwd, configArg);
  const configText = yield* files.readFile(configPath).pipe(
    Effect.mapError(
      (error) =>
        new RunConfigurationInvalid({
          message: `Cannot read configuration document at ${configPath}: ${excerpt(error.message)}.`,
        }),
    ),
  );
  const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
    configText,
  ).pipe(
    Effect.mapError(
      (error) =>
        new RunConfigurationInvalid({
          message: `Configuration document at ${configPath} is not valid JSON: ${excerpt(error.message)}.`,
        }),
    ),
  );
  return yield* decodeProjectConfiguration(document, dirname(configPath)).pipe(
    Effect.mapError((error) => new RunConfigurationInvalid({ message: error.message })),
  );
});

function provenanceOf(frozen: SourceFrozenPayload, ready: WorktreeReadyPayload): RunProvenance {
  return {
    repositoryRoot: frozen.repository.repositoryRoot,
    gitDirectory: frozen.repository.gitDirectory,
    remoteUrl: frozen.repository.remoteUrl,
    sourceRemote: frozen.sourceRemote,
    sourceBranch: frozen.sourceBranch,
    sourceCommit: frozen.sourceCommit,
    taskBranch: frozen.taskBranch,
    workspace: frozen.workspace,
    headCommit: ready.headCommit,
  };
}

function provenanceOfDerived(derived: RunHistoryDerivedState): RunProvenance | null {
  const frozen = derived.sourceFrozen;
  const ready = derived.worktreeReady;
  if (frozen === null || ready === null) {
    return null;
  }
  return provenanceOf(frozen, ready);
}

export const readRetainedRunIdentity = Effect.fn('recordRunIdentity.readRetainedIdentity')(
  function* (
    store: RunIdentityStore['Service'],
    identityPath: string,
    runId: string,
  ): Effect.fn.Return<RequestIdentityDocument | null, RunIdentityStorageError> {
    const status = yield* store.statPath(identityPath);
    if (!status.exists || !status.isRegularFile) {
      return null;
    }
    const bytes = yield* store.readFileBytes(identityPath);
    const text = yield* Effect.try({
      try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      catch: () =>
        new RunIdentityStorageError({
          message: `Retained run identity at ${identityPath} is not valid UTF-8.`,
          runId,
        }),
    });
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RequestIdentityDocumentSchema), {
      onExcessProperty: 'error',
    })(text).pipe(
      Effect.mapError(
        () =>
          new RunIdentityStorageError({
            message: `Retained run identity at ${identityPath} is not a valid closed record.`,
            runId,
          }),
      ),
    );
  },
);

const ensurePlanningState = Effect.fn('recordRunIdentity.ensurePlanningState')(function* (options: {
  readonly runDirectory: string;
  readonly runId: string;
}): Effect.fn.Return<void, RunWorkspaceBlocked | RunHistoryError, RunHistoryStorage> {
  const history = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  if (history.derived.state !== null) {
    return;
  }

  yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
    build: (current) =>
      Effect.gen(function* () {
        if (current.derived.worktreeReady === null) {
          return yield* new RunWorkspaceBlocked({
            message: `Run "${options.runId}" cannot enter planning: durable source and worktree provisioning checkpoints are not recorded.`,
            runId: options.runId,
            problem: 'durable source and worktree provisioning checkpoints are missing',
          });
        }
        if (current.derived.guidanceFrozen === null) {
          return yield* new RunWorkspaceBlocked({
            message: `Run "${options.runId}" cannot enter planning: a durable frozen guidance checkpoint is not recorded.`,
            runId: options.runId,
            problem: 'durable frozen guidance checkpoint is missing',
          });
        }
        const evaluation = evaluateWorkflowTransition(
          {
            state: current.derived.state,
            checkpoint: current.derived.checkpoint,
            plan: null,
          },
          {
            route: 'run-created',
            provisioning: { source: true, lease: true, storage: true, worktree: true },
          },
        );
        if (!evaluation.ok) {
          return yield* new RunWorkspaceBlocked({
            message: `Run "${options.runId}" cannot enter planning: ${evaluation.reason}`,
            runId: options.runId,
            problem: evaluation.missingFact ?? 'workflow creation is not allowed',
          });
        }
        return {
          type: 'workflow-transition',
          payload: {
            route: 'run-created',
            from: current.derived.state,
            to: evaluation.to,
            checkpoint: evaluation.checkpoint,
          },
        } satisfies RunEventDraft;
      }),
  });
});

export const recordRunIdentity = Effect.fn('recordRunIdentity')(function* (
  options: RecordRunIdentityOptions,
): Effect.fn.Return<
  RecordedRunIdentityReport,
  RunIdentityError,
  | ReadinessFiles
  | RunIdentityStore
  | RunHistoryStorage
  | RepositoryLeaseStore
  | RepositoryHostIdentity
  | RoleHostLauncher
  | RunGit
  | GuidanceGit
  | GuidanceSnapshotStore
> {
  const store = yield* RunIdentityStore;
  const runId = options.runId;

  const sourceRequestPath = resolve(options.cwd, options.requestArg);

  const configuration = yield* readRunConfiguration(options.configArg, options.cwd).pipe(
    Effect.mapError((error) => new InvalidRunRequest({ message: error.message, runId })),
  );

  const status = yield* store.statPath(sourceRequestPath).pipe(
    Effect.mapError(
      (error) =>
        new InvalidRunRequest({
          message: `Cannot read request at ${sourceRequestPath}: ${excerpt(error.message)}.`,
          runId,
        }),
    ),
  );
  if (!status.exists) {
    return yield* new InvalidRunRequest({
      message: `Request at ${sourceRequestPath} does not exist or cannot be read.`,
      runId,
    });
  }
  if (!status.isRegularFile) {
    return yield* new InvalidRunRequest({
      message: `Request at ${sourceRequestPath} is not a regular file.`,
      runId,
    });
  }

  const originalBytes = yield* store.readFileBytes(sourceRequestPath).pipe(
    Effect.mapError(
      (error) =>
        new InvalidRunRequest({
          message: `Cannot read request at ${sourceRequestPath}: ${excerpt(error.message)}.`,
          runId,
        }),
    ),
  );

  if (originalBytes.byteLength === 0) {
    return yield* new InvalidRunRequest({
      message: `Request at ${sourceRequestPath} is empty.`,
      runId,
    });
  }
  if (originalBytes.byteLength > configuration.artifacts.maxRequestBytes) {
    return yield* new InvalidRunRequest({
      message: `Request at ${sourceRequestPath} is ${originalBytes.byteLength} bytes, which exceeds the limit of ${configuration.artifacts.maxRequestBytes} bytes.`,
      runId,
    });
  }

  const originalText = yield* Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(originalBytes),
    catch: () =>
      new InvalidRunRequest({
        message: `Request at ${sourceRequestPath} is not valid UTF-8.`,
        runId,
      }),
  });

  const normalizedText = normalizeRequestPromptText(originalText);
  const normalizedBytes = new TextEncoder().encode(normalizedText);
  const originalContentHash = sha256HexOfBytes(originalBytes);
  const normalizedPromptHash = sha256HexOfBytes(normalizedBytes);

  const taskBranch = renderTaskBranch(configuration.taskBranchPolicy, options.taskId);
  if (taskBranch === configuration.sourceBranch) {
    return yield* new InvalidRunRequest({
      message: `Rendered task branch "${taskBranch}" must not equal source branch "${configuration.sourceBranch}".`,
      runId,
    });
  }
  if (!isLegalGitBranchName(taskBranch)) {
    return yield* new InvalidRunRequest({
      message: `Rendered task branch "${taskBranch}" is not a legal Git branch name.`,
      runId,
    });
  }
  const workspace = renderWorkspacePath(configuration.targetRepository, options.taskId);
  if (!isPathInside(configuration.targetRepository, workspace)) {
    return yield* new InvalidRunRequest({
      message: `Run workspace ${workspace} escapes target repository ${configuration.targetRepository}.`,
      runId,
    });
  }

  const runDirectory = runDirectoryOf(configuration, runId);
  const runsRoot = join(
    configuration.targetRepository,
    RUN_STORAGE_DIRECTORY_NAME,
    RUNS_DIRECTORY_NAME,
  );
  const originalPath = join(runDirectory, REQUEST_ORIGINAL_FILENAME);
  const normalizedPath = join(runDirectory, REQUEST_NORMALIZED_FILENAME);
  const identityPath = join(runDirectory, REQUEST_IDENTITY_FILENAME);

  const identityDocument = {
    schemaVersion: REQUEST_IDENTITY_SCHEMA_VERSION,
    runId,
    taskId: options.taskId,
    sourceRequestPath,
    originalByteLength: originalBytes.byteLength,
    originalContentHash,
    normalizedByteLength: normalizedBytes.byteLength,
    normalizedPromptHash,
  } as const;
  const identityBytes = new TextEncoder().encode(`${JSON.stringify(identityDocument, null, 2)}\n`);

  const createRun = Effect.gen(function* () {
    const existing = yield* store.statPath(runDirectory);
    if (existing.exists) {
      const retained = yield* readRetainedRunIdentity(store, identityPath, runId);
      if (
        retained === null ||
        retained.runId !== runId ||
        retained.taskId !== options.taskId ||
        retained.originalContentHash !== originalContentHash ||
        retained.normalizedPromptHash !== normalizedPromptHash
      ) {
        return yield* new DuplicateRunId({
          message: `Run ID "${runId}" already exists at ${runDirectory} without this run's retained identity; a run ID must identify one durable run.`,
          runId,
        });
      }
    } else {
      yield* store.ensureParentDirectory(runsRoot).pipe(
        Effect.mapError(
          (error) =>
            new InvalidRunRequest({
              message: `Cannot prepare run storage at ${runsRoot}: ${excerpt(error.message)}.`,
              runId,
            }),
        ),
      );
      yield* store.createRunDirectoryExclusive(runDirectory, runId);

      const persist = Effect.gen(function* () {
        yield* store.writeFileBytes(originalPath, originalBytes);
        yield* store.writeFileBytes(normalizedPath, normalizedBytes);
        yield* store.writeFileBytes(identityPath, identityBytes);
        yield* appendRunEvent({
          runDirectory,
          runId,
          createIfMissing: true,
          build: () =>
            Effect.succeed<RunEventDraft>({
              type: 'run-created',
              payload: { taskId: options.taskId },
            }),
        });
        yield* reconcileRunReports({ runDirectory, runId });
      }).pipe(
        Effect.mapError(
          (error) =>
            new RunIdentityStorageError({
              message: `Cannot retain request for run "${runId}" at ${runDirectory}: ${excerpt(error.message)}.`,
              runId,
            }),
        ),
        Effect.onError(() => store.removeDirectory(runDirectory).pipe(Effect.ignore)),
      );

      yield* persist;
    }

    const frozen = yield* provisionRunSource({
      runId,
      runDirectory,
      targetRepository: configuration.targetRepository,
      sourceRemote: configuration.sourceRemote,
      sourceBranch: configuration.sourceBranch,
      taskBranch,
      workspace,
    });

    yield* ensureGuidanceSnapshot({
      runId,
      runDirectory,
      targetRepository: configuration.targetRepository,
      guidancePaths: configuration.projectProfile.guidancePaths,
      maxGuidanceBytes: configuration.artifacts.maxGuidanceBytes,
    });

    const ready = yield* provisionRunWorktree(
      {
        runId,
        runDirectory,
        targetRepository: configuration.targetRepository,
        sourceRemote: configuration.sourceRemote,
        sourceBranch: configuration.sourceBranch,
        taskBranch,
        workspace,
      },
      frozen,
    );

    yield* ensurePlanningState({ runDirectory, runId });
    yield* reconcileRunReports({ runDirectory, runId });

    return provenanceOf(frozen, ready);
  });

  yield* preflightRoleHostCapabilities({ configuration, runId });

  const provenance = yield* withRepositoryLease(
    {
      repositoryRoot: configuration.targetRepository,
      runId,
      leaseMs: configuration.timeouts.leaseMs,
    },
    () => createRun,
  );

  return {
    runId,
    taskId: options.taskId,
    runDirectory,
    request: {
      sourcePath: sourceRequestPath,
      originalPath,
      normalizedPath,
      identityPath,
      originalByteLength: originalBytes.byteLength,
      originalContentHash,
      normalizedByteLength: normalizedBytes.byteLength,
      normalizedPromptHash,
    },
    provenance,
  };
});

export interface ReconcileRunReportsOptions {
  readonly runDirectory: string;
  readonly runId: string;
}

const MAX_REPORT_REPLACEMENT_ATTEMPTS = 8;

function encodeDocument(document: WorkflowProgressDocument | CleanupProgressDocument): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
}

export const reconcileRunReports = Effect.fn('reconcileRunReports')(function* (
  options: ReconcileRunReportsOptions,
): Effect.fn.Return<
  RunProgressReport,
  RunHistoryIntegrityError | RunHistoryStorageError | RunHistoryConflict,
  RunHistoryStorage
> {
  const storage = yield* RunHistoryStorage;
  const { runDirectory, runId } = options;
  const historyPath = join(runDirectory, RUN_HISTORY_FILENAME);

  for (let attempt = 1; attempt <= MAX_REPORT_REPLACEMENT_ATTEMPTS; attempt += 1) {
    const history = yield* readVerifiedRunHistory({ runDirectory, runId, createIfMissing: false });
    const derived = history.derived;
    const state = derived.state ?? 'blocked';

    const writes: Array<DerivedReportWrite> = [
      {
        path: join(runDirectory, WORKFLOW_STATE_FILENAME),
        bytes: encodeDocument({
          schemaVersion: WORKFLOW_STATE_PROGRESS_SCHEMA_VERSION,
          runId,
          state,
          checkpoint: derived.checkpoint,
          attempts: derived.attempts,
        }),
      },
    ];
    const removals: Array<string> = [];
    const cleanupPath = join(runDirectory, CLEANUP_PROGRESS_FILENAME);
    const cleanupProgress = derived.cleanupProgress;
    if (cleanupProgress === null) {
      removals.push(cleanupPath);
    } else {
      writes.push({
        path: cleanupPath,
        bytes: encodeDocument({
          schemaVersion: CLEANUP_PROGRESS_SCHEMA_VERSION,
          runId,
          outcome: cleanupProgress.outcome,
          detail: cleanupProgress.detail,
        }),
      });
    }

    const replaced = yield* storage
      .replaceDerivedReports({
        runDirectory,
        runId,
        expectedStreamBytes: history.streamBytes,
        expectedWitnessBytes: history.witnessBytes,
        writes,
        removals,
      })
      .pipe(Effect.result);

    if (Result.isSuccess(replaced)) {
      return {
        runId,
        runDirectory,
        historyPath,
        revision: history.head.revision,
        eventHash: history.head.eventHash,
        workflowState: state,
        checkpoint: derived.checkpoint,
        attempts: derived.attempts,
        cleanupProgress,
        provenance: provenanceOfDerived(derived),
      };
    }
    if (replaced.failure._tag !== 'RunHistoryConflict') {
      return yield* replaced.failure;
    }
  }

  return yield* new RunHistoryConflict({
    message: `Run "${runId}" derived reports are still contended after ${MAX_REPORT_REPLACEMENT_ATTEMPTS} replacement attempts.`,
    runId,
  });
});

export const readRunWorkflowState = Effect.fn('readRunWorkflowState')(function* (
  options: ReadRunWorkflowStateOptions,
): Effect.fn.Return<
  RunProgressReport,
  RunStateUnavailable | RunHistoryIntegrityError | RunHistoryStorageError | RunHistoryConflict,
  ReadinessFiles | RunHistoryStorage
> {
  const runId = options.runId;

  if (!isRunIdentifier(runId)) {
    return yield* new RunStateUnavailable({
      message: `Run ID "${runId}" is not a valid run identifier.`,
      runId,
    });
  }

  const configuration = yield* readRunConfiguration(options.configArg, options.cwd).pipe(
    Effect.mapError((error) => new RunStateUnavailable({ message: error.message, runId })),
  );

  return yield* reconcileRunReports({ runDirectory: runDirectoryOf(configuration, runId), runId });
});

export interface RunContext {
  readonly configuration: ProjectConfiguration;
  readonly runDirectory: string;
}

export interface ResolveRunContextOptions {
  readonly configArg: string;
  readonly cwd: string;
  readonly runId: string;
}

export const resolveRunContext = Effect.fn('resolveRunContext')(function* (
  options: ResolveRunContextOptions,
): Effect.fn.Return<RunContext, InvalidRunRequest, ReadinessFiles> {
  const configuration = yield* readRunConfiguration(options.configArg, options.cwd).pipe(
    Effect.mapError(
      (error) => new InvalidRunRequest({ message: error.message, runId: options.runId }),
    ),
  );
  return { configuration, runDirectory: runDirectoryOf(configuration, options.runId) };
});
