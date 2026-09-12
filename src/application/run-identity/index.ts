import { Context, Effect, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { RUN_STORAGE_DIRECTORY_NAME } from '../../domain/readiness.js';
import { RUNS_DIRECTORY_NAME } from '../../domain/run-locations.js';
import {
  Identifier,
  REQUEST_IDENTITY_FILENAME,
  REQUEST_IDENTITY_SCHEMA_VERSION,
  REQUEST_NORMALIZED_FILENAME,
  REQUEST_ORIGINAL_FILENAME,
  normalizeRequestPromptText,
} from '../../domain/run-identity.js';
import {
  INITIAL_WORKFLOW_STATE,
  WORKFLOW_STATE_FILENAME,
  WORKFLOW_STATE_SCHEMA_VERSION,
  WorkflowStateRecordSchema,
} from '../../domain/workflow.js';
import { decodeProjectConfiguration } from '../project-configuration.js';
import { ReadinessFiles } from '../readiness/index.js';

import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type { WorkflowState, WorkflowStateRecord } from '../../domain/workflow.js';

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

export type RunIdentityError = InvalidRunRequest | DuplicateRunId | RunIdentityStorageError;

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

export interface RecordedRunIdentityReport {
  readonly runId: string;
  readonly taskId: string;
  readonly runDirectory: string;
  readonly request: RecordedRequestFiles;
}

export interface RecordRunIdentityOptions {
  readonly configArg: string;
  readonly cwd: string;
  readonly requestArg: string;
  readonly taskId: string;
  readonly runId: string;
}

export interface RunWorkflowStateReport {
  readonly runId: string;
  readonly workflowState: WorkflowState;
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

export const recordRunIdentity = Effect.fn('recordRunIdentity')(function* (
  options: RecordRunIdentityOptions,
): Effect.fn.Return<
  RecordedRunIdentityReport,
  RunIdentityError,
  ReadinessFiles | RunIdentityStore
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

  const runDirectory = runDirectoryOf(configuration, runId);
  const runsRoot = join(
    configuration.targetRepository,
    RUN_STORAGE_DIRECTORY_NAME,
    RUNS_DIRECTORY_NAME,
  );
  const originalPath = join(runDirectory, REQUEST_ORIGINAL_FILENAME);
  const normalizedPath = join(runDirectory, REQUEST_NORMALIZED_FILENAME);
  const identityPath = join(runDirectory, REQUEST_IDENTITY_FILENAME);
  const statePath = join(runDirectory, WORKFLOW_STATE_FILENAME);

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

  const stateDocument = {
    schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
    runId,
    state: INITIAL_WORKFLOW_STATE,
  } as const;
  const stateBytes = new TextEncoder().encode(`${JSON.stringify(stateDocument, null, 2)}\n`);

  const persist = Effect.gen(function* () {
    yield* store.writeFileBytes(originalPath, originalBytes);
    yield* store.writeFileBytes(normalizedPath, normalizedBytes);
    yield* store.writeFileBytes(identityPath, identityBytes);
    yield* store.writeFileBytes(statePath, stateBytes);
  }).pipe(
    Effect.mapError(
      (error) =>
        new RunIdentityStorageError({
          message: `Cannot retain request for run "${runId}" at ${runDirectory}: ${excerpt(error.message)}.`,
          runId,
        }),
    ),
  );

  yield* persist.pipe(
    Effect.onError(() => store.removeDirectory(runDirectory).pipe(Effect.ignore)),
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
  };
});

export const readRunWorkflowState = Effect.fn('readRunWorkflowState')(function* (
  options: ReadRunWorkflowStateOptions,
): Effect.fn.Return<
  RunWorkflowStateReport,
  RunStateUnavailable,
  ReadinessFiles | RunIdentityStore
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

  const runDirectory = runDirectoryOf(configuration, runId);
  const record = yield* readWorkflowStateRecord(runDirectory, runId);

  return { runId, workflowState: record.state };
});

export const readWorkflowStateRecord = Effect.fn('readWorkflowStateRecord')(function* (
  runDirectory: string,
  runId: string,
): Effect.fn.Return<WorkflowStateRecord, RunStateUnavailable, RunIdentityStore> {
  const store = yield* RunIdentityStore;
  const statePath = join(runDirectory, WORKFLOW_STATE_FILENAME);

  const status = yield* store.statPath(statePath).pipe(
    Effect.mapError(
      (error) =>
        new RunStateUnavailable({
          message: `Cannot inspect workflow state at ${statePath}: ${excerpt(error.message)}.`,
          runId,
        }),
    ),
  );
  if (!status.exists) {
    return yield* new RunStateUnavailable({
      message: `Run "${runId}" has no recorded workflow state at ${statePath}.`,
      runId,
    });
  }
  if (!status.isRegularFile) {
    return yield* new RunStateUnavailable({
      message: `Workflow state at ${statePath} is not a regular file.`,
      runId,
    });
  }

  const stateBytes = yield* store.readFileBytes(statePath).pipe(
    Effect.mapError(
      (error) =>
        new RunStateUnavailable({
          message: `Cannot read workflow state at ${statePath}: ${excerpt(error.message)}.`,
          runId,
        }),
    ),
  );

  const stateText = yield* Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(stateBytes),
    catch: () =>
      new RunStateUnavailable({
        message: `Workflow state at ${statePath} is not valid UTF-8.`,
        runId,
      }),
  });

  const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
    stateText,
  ).pipe(
    Effect.mapError(
      (error) =>
        new RunStateUnavailable({
          message: `Workflow state at ${statePath} is not valid JSON: ${excerpt(error.message)}.`,
          runId,
        }),
    ),
  );

  const record = yield* Schema.decodeUnknownEffect(WorkflowStateRecordSchema, {
    onExcessProperty: 'error',
  })(document).pipe(
    Effect.mapError(
      (error) =>
        new RunStateUnavailable({
          message: `Workflow state at ${statePath} is not a valid state record: ${excerpt(error.message)}.`,
          runId,
        }),
    ),
  );

  if (record.runId !== runId) {
    return yield* new RunStateUnavailable({
      message: `Workflow state at ${statePath} belongs to run "${record.runId}", not "${runId}".`,
      runId,
    });
  }

  return record;
});
