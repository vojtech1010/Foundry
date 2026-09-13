import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';

import { Effect, Layer } from 'effect';

import {
  DuplicateRunId,
  RunIdentityStorageError,
  RunIdentityStore,
} from '../application/run-identity/index.js';
import { writeFileAtomically } from './atomic-file.js';

import type { RunStorageFileStatus } from '../application/run-identity/index.js';

function boundCause(cause: unknown): string {
  return String(cause).replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

const statPath = Effect.fn('runIdentity.statPath')(function* (
  path: string,
): Effect.fn.Return<RunStorageFileStatus, RunIdentityStorageError> {
  const probed = yield* Effect.try({
    try: () => statSync(path),
    catch: () => 'unavailable' as const,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (probed === undefined) {
    return { exists: false, isRegularFile: false };
  }
  return { exists: true, isRegularFile: probed.isFile() };
});

const readFileBytes = Effect.fn('runIdentity.readFileBytes')(function* (
  path: string,
): Effect.fn.Return<Uint8Array, RunIdentityStorageError> {
  return yield* Effect.try({
    try: () => new Uint8Array(readFileSync(path)),
    catch: (cause) =>
      new RunIdentityStorageError({
        message: `Cannot read retained file at ${path}: ${boundCause(cause)}.`,
      }),
  });
});

const ensureParentDirectory = Effect.fn('runIdentity.ensureParentDirectory')(function* (
  path: string,
): Effect.fn.Return<void, RunIdentityStorageError> {
  yield* Effect.try({
    try: () => {
      mkdirSync(path, { recursive: true });
    },
    catch: (cause) =>
      new RunIdentityStorageError({
        message: `Cannot prepare run storage at ${path}: ${boundCause(cause)}.`,
      }),
  });
});

const createRunDirectoryExclusive = Effect.fn('runIdentity.createRunDirectoryExclusive')(function* (
  path: string,
  runId: string,
): Effect.fn.Return<void, DuplicateRunId | RunIdentityStorageError> {
  const created = yield* Effect.try({
    try: () => {
      mkdirSync(path);
      return 'created' as const;
    },
    catch: () => 'failed' as const,
  }).pipe(Effect.orElseSucceed(() => 'failed' as const));
  if (created === 'created') {
    return;
  }
  const probed = yield* statPath(path);
  if (probed.exists) {
    return yield* new DuplicateRunId({
      message: `Run ID "${runId}" already exists at ${path}.`,
      runId,
    });
  }
  return yield* new RunIdentityStorageError({
    message: `Cannot create run directory at ${path}.`,
    runId,
  });
});

const writeFileBytes = Effect.fn('runIdentity.writeFileBytes')(function* (
  path: string,
  bytes: Uint8Array,
): Effect.fn.Return<void, RunIdentityStorageError> {
  yield* Effect.try({
    try: () => {
      writeFileAtomically(path, bytes);
    },
    catch: (cause) =>
      new RunIdentityStorageError({
        message: `Cannot write retained file at ${path}: ${boundCause(cause)}.`,
      }),
  });
});

const removeDirectory = Effect.fn('runIdentity.removeDirectory')(function* (
  path: string,
): Effect.fn.Return<void, RunIdentityStorageError> {
  yield* Effect.try({
    try: () => {
      rmSync(path, { recursive: true, force: true });
    },
    catch: (cause) =>
      new RunIdentityStorageError({
        message: `Cannot remove incomplete run directory at ${path}: ${boundCause(cause)}.`,
      }),
  });
});

const readDirectory = Effect.fn('runIdentity.readDirectory')(function* (
  path: string,
): Effect.fn.Return<ReadonlyArray<string>, RunIdentityStorageError> {
  return yield* Effect.try({
    try: () => readdirSync(path),
    catch: (cause) =>
      new RunIdentityStorageError({
        message: `Cannot read directory at ${path}: ${boundCause(cause)}.`,
      }),
  });
});

export const RunIdentityLive: Layer.Layer<RunIdentityStore> = Layer.succeed(
  RunIdentityStore,
  RunIdentityStore.of({
    statPath,
    readFileBytes,
    ensureParentDirectory,
    createRunDirectoryExclusive,
    writeFileBytes,
    removeDirectory,
    readDirectory,
  }),
);
