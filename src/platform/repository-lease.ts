import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { Effect, Layer, Predicate, Result } from 'effect';

import {
  RepositoryHostIdentity,
  RepositoryLeaseStorageError,
  RepositoryLeaseStore,
} from '../application/repository-lease/index.js';
import { writeFileAtomically } from './atomic-file.js';

import type {
  LocalProcessInstance,
  RepositoryLeaseFileState,
} from '../application/repository-lease/index.js';
import type { LocalProcessObservation } from '../domain/repository-lease.js';

const LINUX_PROCESS_DIRECTORY = '/proc';

const LINUX_BOOT_ID_PATH = `${LINUX_PROCESS_DIRECTORY}/sys/kernel/random/boot_id`;

function boundCause(cause: unknown): string {
  return String(cause).replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

function storageError(path: string, action: string, cause: unknown): RepositoryLeaseStorageError {
  return new RepositoryLeaseStorageError({
    message: `Cannot ${action} the repository lease path at ${path}: ${boundCause(cause)}.`,
    leasePath: path,
  });
}

function processErrorCode(cause: unknown): string | null {
  if (Predicate.isObject(cause) && 'code' in cause && Predicate.isString(cause.code)) {
    return cause.code;
  }
  return null;
}

function startIdentityFromLinuxStat(statText: string): string | null {
  const closingParenthesis = statText.lastIndexOf(')');
  if (closingParenthesis < 0) {
    return null;
  }
  const fields = statText.slice(closingParenthesis + 2).split(' ');
  const startTime = fields[19];
  if (startTime === undefined || !/^\d+$/u.test(startTime)) {
    return null;
  }
  const bootId = readFileSync(LINUX_BOOT_ID_PATH, 'utf8').trim();
  if (bootId.length === 0) {
    return null;
  }
  return `linux:${bootId}:${startTime}`;
}

function probeLinuxProcess(processId: number): LocalProcessObservation {
  if (!existsSync(`${LINUX_PROCESS_DIRECTORY}/self/stat`)) {
    return { kind: 'unavailable', detail: 'the Linux process table is not available' };
  }
  if (!existsSync(`${LINUX_PROCESS_DIRECTORY}/${processId}`)) {
    return { kind: 'absent' };
  }
  try {
    const startIdentity = startIdentityFromLinuxStat(
      readFileSync(`${LINUX_PROCESS_DIRECTORY}/${processId}/stat`, 'utf8'),
    );
    if (startIdentity === null) {
      return {
        kind: 'unavailable',
        detail: `the start identity of process ${processId} could not be derived`,
      };
    }
    return { kind: 'running', startIdentity };
  } catch (cause) {
    return {
      kind: 'unavailable',
      detail: `process ${processId} could not be inspected: ${boundCause(cause)}`,
    };
  }
}

function probePortableProcess(processId: number): LocalProcessObservation {
  try {
    process.kill(processId, 0);
    return { kind: 'running', startIdentity: null };
  } catch (cause) {
    const code = processErrorCode(cause);
    if (code === 'ESRCH') {
      return { kind: 'absent' };
    }
    if (code === 'EPERM') {
      return { kind: 'running', startIdentity: null };
    }
    return {
      kind: 'unavailable',
      detail: `process ${processId} could not be inspected: ${boundCause(cause)}`,
    };
  }
}

function probeProcess(processId: number): LocalProcessObservation {
  return process.platform === 'linux'
    ? probeLinuxProcess(processId)
    : probePortableProcess(processId);
}

function currentProcessInstance(): LocalProcessInstance {
  const observation = probeProcess(process.pid);
  return {
    processId: process.pid,
    processStartIdentity: observation.kind === 'running' ? observation.startIdentity : null,
  };
}

const ensureDirectory = Effect.fn('repositoryLeaseStore.ensureDirectory')(function* (
  path: string,
): Effect.fn.Return<void, RepositoryLeaseStorageError> {
  yield* Effect.try({
    try: () => {
      mkdirSync(path, { recursive: true });
    },
    catch: (cause) => storageError(path, 'prepare the directory for', cause),
  });
});

const statPath = Effect.fn('repositoryLeaseStore.statPath')(function* (
  path: string,
): Effect.fn.Return<RepositoryLeaseFileState, RepositoryLeaseStorageError> {
  const probed = yield* Effect.try({
    try: () => statSync(path, { throwIfNoEntry: false }),
    catch: (cause) => storageError(path, 'inspect', cause),
  });
  if (probed === undefined) {
    return { kind: 'missing' } as const;
  }
  if (!probed.isFile()) {
    return { kind: 'not-regular-file' } as const;
  }
  const bytes = yield* Effect.try({
    try: () => new Uint8Array(readFileSync(path)),
    catch: (cause) => storageError(path, 'read', cause),
  });
  return { kind: 'file', bytes } as const;
});

const createGuardFile = Effect.fn('repositoryLeaseStore.createGuardFile')(function* (
  path: string,
  bytes: Uint8Array,
): Effect.fn.Return<boolean, RepositoryLeaseStorageError> {
  const created = yield* Effect.try({
    try: () => {
      const handle = openSync(path, 'wx');
      try {
        writeSync(handle, bytes);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      return true;
    },
    catch: (cause) => storageError(path, 'create the guard file at', cause),
  }).pipe(Effect.result);
  if (Result.isSuccess(created)) {
    return true;
  }
  const state = yield* statPath(path);
  if (state.kind !== 'missing') {
    return false;
  }
  return yield* created.failure;
});

const writeLeaseFile = Effect.fn('repositoryLeaseStore.writeFileAtomically')(function* (
  path: string,
  bytes: Uint8Array,
): Effect.fn.Return<void, RepositoryLeaseStorageError> {
  yield* Effect.try({
    try: () => {
      writeFileAtomically(path, bytes);
    },
    catch: (cause) => storageError(path, 'write', cause),
  });
});

const removeFile = Effect.fn('repositoryLeaseStore.removeFile')(function* (
  path: string,
): Effect.fn.Return<void, RepositoryLeaseStorageError> {
  yield* Effect.try({
    try: () => {
      rmSync(path, { force: true });
    },
    catch: (cause) => storageError(path, 'remove', cause),
  });
});

export const RepositoryLeaseStoreLive: Layer.Layer<RepositoryLeaseStore> = Layer.succeed(
  RepositoryLeaseStore,
  RepositoryLeaseStore.of({
    ensureDirectory,
    statPath,
    createGuardFile,
    writeFileAtomically: writeLeaseFile,
    removeFile,
  }),
);

export const RepositoryHostIdentityLive: Layer.Layer<RepositoryHostIdentity> = Layer.succeed(
  RepositoryHostIdentity,
  RepositoryHostIdentity.of({
    hostIdentity: Effect.sync(() => hostname()),
    currentProcess: Effect.sync(currentProcessInstance),
    probeProcess: (processId: number) => Effect.sync(() => probeProcess(processId)),
  }),
);

export const RepositoryLeaseLive = Layer.mergeAll(
  RepositoryLeaseStoreLive,
  RepositoryHostIdentityLive,
);
