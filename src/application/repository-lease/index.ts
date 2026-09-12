import { Context, DateTime, Deferred, Duration, Effect, Result, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { RUN_STORAGE_DIRECTORY_NAME } from '../../domain/readiness.js';
import {
  REPOSITORY_LEASE_FILENAME,
  REPOSITORY_LEASE_GUARD_FILENAME,
  REPOSITORY_LEASE_SCHEMA_VERSION,
  RepositoryLeaseGuardJson,
  RepositoryLeaseJson,
  classifyRepositoryLeaseOwner,
  describeRepositoryLeaseOwner,
  repositoryLeaseExpired,
} from '../../domain/repository-lease.js';

import type {
  LocalProcessObservation,
  RepositoryLeaseGuardRecord,
  RepositoryLeaseRecord,
} from '../../domain/repository-lease.js';

export class RepositoryLeaseContended extends Schema.TaggedError<RepositoryLeaseContended>()(
  'RepositoryLeaseContended',
  {
    message: Schema.String,
    runId: Schema.optional(Schema.String),
    leasePath: Schema.optional(Schema.String),
  },
) {}

export class RepositoryLeaseAmbiguous extends Schema.TaggedError<RepositoryLeaseAmbiguous>()(
  'RepositoryLeaseAmbiguous',
  {
    message: Schema.String,
    runId: Schema.optional(Schema.String),
    leasePath: Schema.optional(Schema.String),
  },
) {}

export class RepositoryLeaseOwnershipLost extends Schema.TaggedError<RepositoryLeaseOwnershipLost>()(
  'RepositoryLeaseOwnershipLost',
  {
    message: Schema.String,
    runId: Schema.optional(Schema.String),
    leasePath: Schema.optional(Schema.String),
  },
) {}

export class RepositoryLeaseStorageError extends Schema.TaggedError<RepositoryLeaseStorageError>()(
  'RepositoryLeaseStorageError',
  {
    message: Schema.String,
    runId: Schema.optional(Schema.String),
    leasePath: Schema.optional(Schema.String),
  },
) {}

export type RepositoryLeaseError =
  | RepositoryLeaseContended
  | RepositoryLeaseAmbiguous
  | RepositoryLeaseOwnershipLost
  | RepositoryLeaseStorageError;

export type RepositoryLeaseFileState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-regular-file' }
  | { readonly kind: 'file'; readonly bytes: Uint8Array };

export class RepositoryLeaseStore extends Context.Service<
  RepositoryLeaseStore,
  {
    readonly ensureDirectory: (path: string) => Effect.Effect<void, RepositoryLeaseStorageError>;
    readonly statPath: (
      path: string,
    ) => Effect.Effect<RepositoryLeaseFileState, RepositoryLeaseStorageError>;
    readonly createGuardFile: (
      path: string,
      bytes: Uint8Array,
    ) => Effect.Effect<boolean, RepositoryLeaseStorageError>;
    readonly writeFileAtomically: (
      path: string,
      bytes: Uint8Array,
    ) => Effect.Effect<void, RepositoryLeaseStorageError>;
    readonly removeFile: (path: string) => Effect.Effect<void, RepositoryLeaseStorageError>;
  }
>()('foundry/application/repository-lease/Store') {}

export interface LocalProcessInstance {
  readonly processId: number;
  readonly processStartIdentity: string | null;
}

export class RepositoryHostIdentity extends Context.Service<
  RepositoryHostIdentity,
  {
    readonly hostIdentity: Effect.Effect<string>;
    readonly currentProcess: Effect.Effect<LocalProcessInstance>;
    readonly probeProcess: (processId: number) => Effect.Effect<LocalProcessObservation>;
  }
>()('foundry/application/repository-lease/HostIdentity') {}

export interface RepositoryLeaseHandle {
  readonly ownerId: string;
  readonly leasePath: string;
  readonly acquiredAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
  readonly renew: Effect.Effect<RepositoryLeaseRecord, RepositoryLeaseError>;
  readonly release: Effect.Effect<void, RepositoryLeaseError>;
}

export interface AcquireRepositoryLeaseOptions {
  readonly repositoryRoot: string;
  readonly runId: string;
  readonly leaseMs: number;
}

interface RepositoryLeaseLocation {
  readonly storageDirectory: string;
  readonly leasePath: string;
  readonly guardPath: string;
}

interface RenewRepositoryLeaseOptions {
  readonly leasePath: string;
  readonly runId: string;
  readonly leaseMs: number;
  readonly ownerId: string;
}

interface ReleaseRepositoryLeaseOptions {
  readonly leasePath: string;
  readonly runId: string;
  readonly ownerId: string;
}

interface LeaseCriticalSection {
  readonly release: Effect.Effect<void>;
}

const LEASE_GUARD_RETRY_ATTEMPTS = 50;

const LEASE_GUARD_RETRY_DELAY = Duration.millis(4);

const LEASE_HEARTBEAT_DIVISOR = 3;

function repositoryLeaseLocation(repositoryRoot: string): RepositoryLeaseLocation {
  const storageDirectory = join(repositoryRoot, RUN_STORAGE_DIRECTORY_NAME);
  return {
    storageDirectory,
    leasePath: join(storageDirectory, REPOSITORY_LEASE_FILENAME),
    guardPath: join(storageDirectory, REPOSITORY_LEASE_GUARD_FILENAME),
  };
}

function guardPathFor(leasePath: string): string {
  return join(dirname(leasePath), REPOSITORY_LEASE_GUARD_FILENAME);
}

function ambiguous(runId: string, path: string, detail: string): RepositoryLeaseAmbiguous {
  return new RepositoryLeaseAmbiguous({
    message: `Repository ownership at ${path} cannot be verified for run "${runId}": ${detail}. A person must investigate repository ownership before Foundry continues.`,
    runId,
    leasePath: path,
  });
}

function contended(
  runId: string,
  leasePath: string,
  owner: RepositoryLeaseRecord,
  detail: string,
): RepositoryLeaseContended {
  return new RepositoryLeaseContended({
    message: `Target repository lease at ${leasePath} is held by ${describeRepositoryLeaseOwner(owner)} until ${DateTime.formatIso(owner.expiresAt)}. ${detail} Run "${runId}" cannot drive the repository while another owner is live; a person must investigate before it continues.`,
    runId,
    leasePath,
  });
}

function ownershipLost(
  options: RenewRepositoryLeaseOptions | ReleaseRepositoryLeaseOptions,
  detail: string,
): RepositoryLeaseOwnershipLost {
  return new RepositoryLeaseOwnershipLost({
    message: `Run "${options.runId}" no longer owns the repository lease at ${options.leasePath}: ${detail}. Further repository writes stop because ownership was lost.`,
    runId: options.runId,
    leasePath: options.leasePath,
  });
}

function encodeLeaseRecord(record: RepositoryLeaseRecord): Uint8Array {
  return new TextEncoder().encode(`${Schema.encodeSync(RepositoryLeaseJson)(record)}\n`);
}

function encodeGuardRecord(record: RepositoryLeaseGuardRecord): Uint8Array {
  return new TextEncoder().encode(`${Schema.encodeSync(RepositoryLeaseGuardJson)(record)}\n`);
}

const decodeLeaseRecord = Effect.fn('repositoryLease.decodeLeaseRecord')(function* (
  bytes: Uint8Array,
  runId: string,
  leasePath: string,
): Effect.fn.Return<RepositoryLeaseRecord, RepositoryLeaseAmbiguous> {
  const text = yield* Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    catch: () => ambiguous(runId, leasePath, 'the lease record is not valid UTF-8'),
  });
  return yield* Schema.decodeUnknownEffect(RepositoryLeaseJson, {
    onExcessProperty: 'error',
  })(text).pipe(
    Effect.mapError(() =>
      ambiguous(runId, leasePath, 'the lease record is not a valid closed record'),
    ),
  );
});

const decodeGuardRecord = Effect.fn('repositoryLease.decodeGuardRecord')(function* (
  bytes: Uint8Array,
  runId: string,
  guardPath: string,
): Effect.fn.Return<RepositoryLeaseGuardRecord, RepositoryLeaseAmbiguous> {
  const text = yield* Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    catch: () => ambiguous(runId, guardPath, 'the lease guard is not valid UTF-8'),
  });
  return yield* Schema.decodeUnknownEffect(RepositoryLeaseGuardJson, {
    onExcessProperty: 'error',
  })(text).pipe(
    Effect.mapError(() =>
      ambiguous(runId, guardPath, 'the lease guard is not a valid closed record'),
    ),
  );
});

const removeGuardIfOwned = Effect.fn('repositoryLease.removeGuardIfOwned')(function* (
  store: RepositoryLeaseStore['Service'],
  guardPath: string,
  guardOwnerId: string,
): Effect.fn.Return<void, RepositoryLeaseStorageError> {
  const state = yield* store.statPath(guardPath);
  if (state.kind !== 'file') {
    return;
  }
  const decoded = yield* decodeGuardRecord(state.bytes, 'guard-release', guardPath).pipe(
    Effect.result,
  );
  if (Result.isFailure(decoded) || decoded.success.ownerId !== guardOwnerId) {
    return;
  }
  yield* store.removeFile(guardPath);
});

const enterLeaseCriticalSection = Effect.fn('repositoryLease.enterCriticalSection')(function* (
  store: RepositoryLeaseStore['Service'],
  identity: RepositoryHostIdentity['Service'],
  guardPath: string,
  runId: string,
): Effect.fn.Return<LeaseCriticalSection, RepositoryLeaseError> {
  const hostIdentity = yield* identity.hostIdentity;
  const currentProcess = yield* identity.currentProcess;
  const guardOwnerId = randomUUID();
  const guardRecord: RepositoryLeaseGuardRecord = {
    schemaVersion: REPOSITORY_LEASE_SCHEMA_VERSION,
    ownerId: guardOwnerId,
    hostIdentity,
    processId: currentProcess.processId,
    processStartIdentity: currentProcess.processStartIdentity,
    acquiredAt: yield* DateTime.now,
  };
  const guardBytes = encodeGuardRecord(guardRecord);

  let contendedHolder: RepositoryLeaseGuardRecord | null = null;
  let ambiguousDetail = 'the lease guard is held by an unidentified owner';

  for (let attempt = 1; attempt <= LEASE_GUARD_RETRY_ATTEMPTS; attempt += 1) {
    const created = yield* store.createGuardFile(guardPath, guardBytes);
    if (created) {
      const release = removeGuardIfOwned(store, guardPath, guardOwnerId).pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            `Could not remove the repository lease guard at ${guardPath} for run "${runId}": ${error.message}`,
          ),
        ),
        Effect.ignore,
      );
      return { release };
    }
    const state = yield* store.statPath(guardPath);
    if (state.kind === 'missing') {
      continue;
    }
    if (state.kind === 'not-regular-file') {
      return yield* ambiguous(runId, guardPath, 'the lease guard path is not a regular file');
    }
    const decoded = yield* decodeGuardRecord(state.bytes, runId, guardPath).pipe(Effect.result);
    if (Result.isFailure(decoded)) {
      contendedHolder = null;
      ambiguousDetail = 'the lease guard contents are not a valid record';
    } else {
      const guard = decoded.success;
      const liveness = classifyRepositoryLeaseOwner(
        guard,
        hostIdentity,
        yield* identity.probeProcess(guard.processId),
      );
      if (liveness === 'dead') {
        yield* store.removeFile(guardPath);
        continue;
      }
      if (liveness === 'live') {
        contendedHolder = guard;
      } else {
        contendedHolder = null;
        ambiguousDetail = `the lease guard is held by an unverifiable owner: ${describeRepositoryLeaseOwner(guard)}`;
      }
    }
    yield* Effect.sleep(LEASE_GUARD_RETRY_DELAY);
  }

  if (contendedHolder !== null) {
    return yield* new RepositoryLeaseContended({
      message: `Repository lease guard at ${guardPath} is still held by ${describeRepositoryLeaseOwner(contendedHolder)} after ${LEASE_GUARD_RETRY_ATTEMPTS} attempts. Run "${runId}" cannot take the lease while another process is live; a person must investigate before it continues.`,
      runId,
      leasePath: guardPath,
    });
  }
  return yield* ambiguous(runId, guardPath, ambiguousDetail);
});

const renewRepositoryLease = Effect.fn('repositoryLease.renew')(function* (
  store: RepositoryLeaseStore['Service'],
  identity: RepositoryHostIdentity['Service'],
  options: RenewRepositoryLeaseOptions,
): Effect.fn.Return<RepositoryLeaseRecord, RepositoryLeaseError> {
  const guardPath = guardPathFor(options.leasePath);
  const section = yield* enterLeaseCriticalSection(store, identity, guardPath, options.runId);
  return yield* Effect.gen(function* () {
    const now = yield* DateTime.now;
    const state = yield* store.statPath(options.leasePath);
    if (state.kind !== 'file') {
      return yield* ownershipLost(options, 'the lease record is missing or is not a regular file');
    }
    const decoded = yield* decodeLeaseRecord(state.bytes, options.runId, options.leasePath).pipe(
      Effect.result,
    );
    if (Result.isFailure(decoded)) {
      return yield* decoded.failure;
    }
    const current = decoded.success;
    if (current.ownerId !== options.ownerId) {
      return yield* ownershipLost(
        options,
        `the lease is now held by ${describeRepositoryLeaseOwner(current)}`,
      );
    }
    const renewed: RepositoryLeaseRecord = {
      ...current,
      heartbeatAt: now,
      expiresAt: DateTime.add(now, { milliseconds: options.leaseMs }),
    };
    yield* store.writeFileAtomically(options.leasePath, encodeLeaseRecord(renewed));
    return renewed;
  }).pipe(Effect.ensuring(section.release));
});

const releaseRepositoryLease = Effect.fn('repositoryLease.release')(function* (
  store: RepositoryLeaseStore['Service'],
  identity: RepositoryHostIdentity['Service'],
  options: ReleaseRepositoryLeaseOptions,
): Effect.fn.Return<void, RepositoryLeaseError> {
  const guardPath = guardPathFor(options.leasePath);
  const section = yield* enterLeaseCriticalSection(store, identity, guardPath, options.runId);
  yield* Effect.gen(function* () {
    const state = yield* store.statPath(options.leasePath);
    if (state.kind === 'missing') {
      return;
    }
    if (state.kind === 'not-regular-file') {
      return yield* ambiguous(
        options.runId,
        options.leasePath,
        'the lease path is not a regular file, so the record was left untouched',
      );
    }
    const decoded = yield* decodeLeaseRecord(state.bytes, options.runId, options.leasePath).pipe(
      Effect.result,
    );
    if (Result.isFailure(decoded)) {
      return yield* decoded.failure;
    }
    if (decoded.success.ownerId !== options.ownerId) {
      return;
    }
    yield* store.removeFile(options.leasePath);
  }).pipe(Effect.ensuring(section.release));
});

export const acquireRepositoryLease = Effect.fn('acquireRepositoryLease')(function* (
  options: AcquireRepositoryLeaseOptions,
): Effect.fn.Return<
  RepositoryLeaseHandle,
  RepositoryLeaseError,
  RepositoryLeaseStore | RepositoryHostIdentity
> {
  const store = yield* RepositoryLeaseStore;
  const identity = yield* RepositoryHostIdentity;
  const { storageDirectory, leasePath, guardPath } = repositoryLeaseLocation(
    options.repositoryRoot,
  );
  yield* store.ensureDirectory(storageDirectory);

  const hostIdentity = yield* identity.hostIdentity;
  const currentProcess = yield* identity.currentProcess;
  const now = yield* DateTime.now;
  const record: RepositoryLeaseRecord = {
    schemaVersion: REPOSITORY_LEASE_SCHEMA_VERSION,
    ownerId: randomUUID(),
    hostIdentity,
    processId: currentProcess.processId,
    processStartIdentity: currentProcess.processStartIdentity,
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: DateTime.add(now, { milliseconds: options.leaseMs }),
  };

  const section = yield* enterLeaseCriticalSection(store, identity, guardPath, options.runId);
  yield* Effect.gen(function* () {
    const state = yield* store.statPath(leasePath);
    if (state.kind === 'missing') {
      yield* store.writeFileAtomically(leasePath, encodeLeaseRecord(record));
      return;
    }
    if (state.kind === 'not-regular-file') {
      return yield* ambiguous(
        options.runId,
        leasePath,
        'the lease path is not a regular file, so ownership fails closed',
      );
    }
    const decoded = yield* decodeLeaseRecord(state.bytes, options.runId, leasePath).pipe(
      Effect.result,
    );
    if (Result.isFailure(decoded)) {
      return yield* decoded.failure;
    }
    const existing = decoded.success;
    if (!repositoryLeaseExpired(existing, now)) {
      return yield* contended(options.runId, leasePath, existing, 'The lease has not expired.');
    }
    const liveness = classifyRepositoryLeaseOwner(
      existing,
      hostIdentity,
      yield* identity.probeProcess(existing.processId),
    );
    if (liveness === 'live') {
      return yield* contended(
        options.runId,
        leasePath,
        existing,
        'The expired lease owner process is still running.',
      );
    }
    if (liveness === 'unverifiable') {
      return yield* ambiguous(
        options.runId,
        leasePath,
        `the expired lease owner (${describeRepositoryLeaseOwner(existing)}) is not verifiably dead`,
      );
    }
    yield* store.writeFileAtomically(leasePath, encodeLeaseRecord(record));
  }).pipe(Effect.ensuring(section.release));

  return {
    ownerId: record.ownerId,
    leasePath,
    acquiredAt: record.acquiredAt,
    expiresAt: record.expiresAt,
    renew: renewRepositoryLease(store, identity, {
      leasePath,
      runId: options.runId,
      leaseMs: options.leaseMs,
      ownerId: record.ownerId,
    }),
    release: releaseRepositoryLease(store, identity, {
      leasePath,
      runId: options.runId,
      ownerId: record.ownerId,
    }),
  };
});

const monitorRepositoryLease = Effect.fn('repositoryLease.monitor')(function* (
  lease: RepositoryLeaseHandle,
  leaseMs: number,
  ownershipLostSignal: Deferred.Deferred<never, RepositoryLeaseError>,
): Effect.fn.Return<void> {
  const interval = Duration.millis(Math.max(1, Math.floor(leaseMs / LEASE_HEARTBEAT_DIVISOR)));
  while (true) {
    yield* Effect.sleep(interval);
    const renewed = yield* lease.renew.pipe(Effect.result);
    if (Result.isFailure(renewed)) {
      yield* Deferred.fail(ownershipLostSignal, renewed.failure);
      return;
    }
  }
});

export const withRepositoryLease = Effect.fn('withRepositoryLease')(function* <A, E, R>(
  options: AcquireRepositoryLeaseOptions,
  operation: (lease: RepositoryLeaseHandle) => Effect.Effect<A, E, R>,
): Effect.fn.Return<
  A,
  E | RepositoryLeaseError,
  RepositoryLeaseStore | RepositoryHostIdentity | R
> {
  return yield* Effect.scoped(
    Effect.acquireRelease(acquireRepositoryLease(options), (lease) =>
      lease.release.pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            `Could not release the repository lease at ${lease.leasePath} for run "${options.runId}": ${error.message}`,
          ),
        ),
        Effect.ignore,
      ),
    ).pipe(
      Effect.flatMap((lease) =>
        Effect.gen(function* () {
          const ownershipLostSignal = yield* Deferred.make<never, RepositoryLeaseError>();
          yield* Effect.forkScoped(
            monitorRepositoryLease(lease, options.leaseMs, ownershipLostSignal),
          );
          return yield* Effect.raceFirst(operation(lease), Deferred.await(ownershipLostSignal));
        }),
      ),
    ),
  );
});
