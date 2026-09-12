import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Duration, Effect, Layer } from 'effect';

import {
  RunHistoryStorage,
  RunHistoryStorageError,
  RunHistoryConflict,
} from '../application/run-history/index.js';
import {
  RUN_HISTORY_FILENAME,
  RUN_HISTORY_LOCK_FILENAME,
  RUN_HISTORY_WITNESS_FILENAME,
} from '../domain/run-history.js';

import type {
  CommitRunHistoryOptions,
  RunHistoryFileState,
  RunHistoryStorageSnapshot,
} from '../application/run-history/index.js';

const LOCK_RETRY_ATTEMPTS = 50;

const LOCK_RETRY_DELAY = Duration.millis(4);

function boundCause(cause: unknown): string {
  return String(cause).replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

function removeTemporaryFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // The temporary file may never have been created.
  }
}

function syncDirectory(directory: string): void {
  let handle: number | undefined;
  try {
    handle = openSync(directory, 'r');
    fsyncSync(handle);
  } catch {
    // A directory flush is not supported on every platform; the rename stays atomic.
  } finally {
    if (handle !== undefined) {
      closeSync(handle);
    }
  }
}

function writeFileAtomically(path: string, bytes: Uint8Array): void {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = openSync(temporaryPath, 'wx');
    try {
      writeSync(handle, bytes);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporaryPath, path);
    syncDirectory(directory);
  } catch (cause) {
    removeTemporaryFile(temporaryPath);
    throw cause;
  }
}

function readHistoryFile(path: string): Effect.Effect<RunHistoryFileState, RunHistoryStorageError> {
  return Effect.gen(function* () {
    const probed = yield* Effect.try({
      try: () => statSync(path),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (probed === undefined) {
      return { kind: 'missing' } as const;
    }
    if (!probed.isFile()) {
      return { kind: 'not-regular-file' } as const;
    }
    const bytes = yield* Effect.try({
      try: () => new Uint8Array(readFileSync(path)),
      catch: (cause) =>
        new RunHistoryStorageError({
          message: `Cannot read run history file at ${path}: ${boundCause(cause)}.`,
        }),
    });
    return { kind: 'file', bytes } as const;
  });
}

function expectationMatches(state: RunHistoryFileState, expected: Uint8Array | null): boolean {
  if (expected === null) {
    return state.kind === 'missing';
  }
  if (state.kind !== 'file') {
    return false;
  }
  return Buffer.compare(Buffer.from(state.bytes), Buffer.from(expected)) === 0;
}

function tryCreateLockFile(path: string, owner: string): boolean {
  try {
    const handle = openSync(path, 'wx');
    try {
      writeSync(handle, `${JSON.stringify({ owner, processId: process.pid })}\n`);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    return true;
  } catch {
    return false;
  }
}

function releaseLockFile(path: string, owner: string): void {
  try {
    const text = readFileSync(path, 'utf8');
    if (!text.includes(owner)) {
      return;
    }
    unlinkSync(path);
  } catch {
    // A missing lock file means the lock is already released.
  }
}

interface HistoryLock {
  readonly release: () => Effect.Effect<void>;
}

const acquireHistoryLock = Effect.fn('runHistory.acquireLock')(function* (
  runDirectory: string,
  runId: string,
): Effect.fn.Return<HistoryLock, RunHistoryConflict> {
  const lockPath = join(runDirectory, RUN_HISTORY_LOCK_FILENAME);
  const owner = randomUUID();
  for (let attempt = 1; attempt <= LOCK_RETRY_ATTEMPTS; attempt += 1) {
    const created = yield* Effect.sync(() => tryCreateLockFile(lockPath, owner));
    if (created) {
      return { release: () => Effect.sync(() => releaseLockFile(lockPath, owner)) };
    }
    if (attempt < LOCK_RETRY_ATTEMPTS) {
      yield* Effect.sleep(LOCK_RETRY_DELAY);
    }
  }
  return yield* new RunHistoryConflict({
    message: `Run "${runId}" history is locked by another writer at ${lockPath}.`,
    runId,
  });
});

const publishHistoryFile = Effect.fn('runHistory.publishFile')(function* (
  path: string,
  bytes: Uint8Array,
): Effect.fn.Return<void, RunHistoryStorageError> {
  yield* Effect.try({
    try: () => {
      writeFileAtomically(path, bytes);
    },
    catch: (cause) =>
      new RunHistoryStorageError({
        message: `Cannot publish run history file at ${path}: ${boundCause(cause)}.`,
      }),
  });
});

const readHistoryFiles = Effect.fn('runHistory.readHistoryFiles')(function* (
  runDirectory: string,
): Effect.fn.Return<RunHistoryStorageSnapshot, RunHistoryStorageError> {
  const stream = yield* readHistoryFile(join(runDirectory, RUN_HISTORY_FILENAME));
  const witness = yield* readHistoryFile(join(runDirectory, RUN_HISTORY_WITNESS_FILENAME));
  return { stream, witness };
});

const commitHistory = Effect.fn('runHistory.commitHistory')(function* (
  options: CommitRunHistoryOptions,
): Effect.fn.Return<void, RunHistoryConflict | RunHistoryStorageError> {
  const lock = yield* acquireHistoryLock(options.runDirectory, options.runId);
  yield* Effect.gen(function* () {
    const snapshot = yield* readHistoryFiles(options.runDirectory);
    if (
      !expectationMatches(snapshot.stream, options.expectedStreamBytes) ||
      !expectationMatches(snapshot.witness, options.expectedWitnessBytes)
    ) {
      return yield* new RunHistoryConflict({
        message: `Run "${options.runId}" history changed after it was read; the append must be re-evaluated against the latest history.`,
        runId: options.runId,
      });
    }
    yield* publishHistoryFile(
      join(options.runDirectory, RUN_HISTORY_WITNESS_FILENAME),
      options.nextWitnessBytes,
    );
    yield* publishHistoryFile(
      join(options.runDirectory, RUN_HISTORY_FILENAME),
      options.nextStreamBytes,
    );
  }).pipe(Effect.ensuring(lock.release()));
});

export const RunHistoryLive: Layer.Layer<RunHistoryStorage> = Layer.succeed(
  RunHistoryStorage,
  RunHistoryStorage.of({
    readHistoryFiles,
    commitHistory,
  }),
);
