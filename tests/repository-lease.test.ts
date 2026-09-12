import { describe, expect, it } from '@effect/vitest';
import { DateTime, Duration, Effect, Fiber, Layer, Schema } from 'effect';
import { TestClock } from 'effect/testing';

import {
  RepositoryHostIdentity,
  RepositoryLeaseAmbiguous,
  RepositoryLeaseContended,
  RepositoryLeaseOwnershipLost,
  RepositoryLeaseStorageError,
  RepositoryLeaseStore,
  acquireRepositoryLease,
  withRepositoryLease,
} from '../src/application/repository-lease/index.js';
import type {
  LocalProcessInstance,
  RepositoryLeaseFileState,
} from '../src/application/repository-lease/index.js';
import {
  REPOSITORY_LEASE_FILENAME,
  REPOSITORY_LEASE_GUARD_FILENAME,
  RepositoryLeaseGuardJson,
  RepositoryLeaseJson,
  classifyRepositoryLeaseOwner,
} from '../src/domain/repository-lease.js';
import type {
  LocalProcessObservation,
  RepositoryLeaseRecord,
} from '../src/domain/repository-lease.js';

const REPOSITORY_ROOT = '/repository';

const STORAGE_DIRECTORY = `${REPOSITORY_ROOT}/.agent`;

const LEASE_PATH = `${STORAGE_DIRECTORY}/${REPOSITORY_LEASE_FILENAME}`;

const GUARD_PATH = `${STORAGE_DIRECTORY}/${REPOSITORY_LEASE_GUARD_FILENAME}`;

const FIRST_OWNER_ID = '11111111-1111-4111-8111-111111111111';

const SUCCESSOR_OWNER_ID = '22222222-2222-4222-8222-222222222222';

const HOST_IDENTITY = 'host-alpha';

const OWNER_PROCESS_ID = 4242;

const OWNER_START_IDENTITY = 'linux:boot:42';

const EXPIRED_AT = '1969-12-31T23:59:59.000Z';

const FRESH_EXPIRY = '1970-01-01T00:01:00.000Z';

const encoder = new TextEncoder();

interface FakeLeaseWorld {
  readonly files: Map<string, Uint8Array>;
  hostIdentity: string;
  currentProcess: LocalProcessInstance;
  readonly observations: Map<number, LocalProcessObservation>;
  writeFailure: RepositoryLeaseStorageError | null;
}

function makeWorld(): FakeLeaseWorld {
  return {
    files: new Map(),
    hostIdentity: HOST_IDENTITY,
    currentProcess: { processId: OWNER_PROCESS_ID, processStartIdentity: OWNER_START_IDENTITY },
    observations: new Map([
      [OWNER_PROCESS_ID, { kind: 'running', startIdentity: OWNER_START_IDENTITY }],
    ]),
    writeFailure: null,
  };
}

function leaseWorldLayer(
  world: FakeLeaseWorld,
): Layer.Layer<RepositoryLeaseStore | RepositoryHostIdentity> {
  const store = RepositoryLeaseStore.of({
    ensureDirectory: () => Effect.void,
    statPath: (path: string) =>
      Effect.sync((): RepositoryLeaseFileState => {
        const bytes = world.files.get(path);
        return bytes === undefined ? { kind: 'missing' } : { kind: 'file', bytes };
      }),
    createGuardFile: (path: string, bytes: Uint8Array) =>
      Effect.sync(() => {
        if (world.files.has(path)) {
          return false;
        }
        world.files.set(path, bytes);
        return true;
      }),
    writeFileAtomically: (path: string, bytes: Uint8Array) =>
      Effect.suspend(() => {
        if (world.writeFailure !== null) {
          return Effect.fail(world.writeFailure);
        }
        world.files.set(path, bytes);
        return Effect.void;
      }),
    removeFile: (path: string) =>
      Effect.sync(() => {
        world.files.delete(path);
      }),
  });
  const identity = RepositoryHostIdentity.of({
    hostIdentity: Effect.sync(() => world.hostIdentity),
    currentProcess: Effect.sync(() => world.currentProcess),
    probeProcess: (processId: number) =>
      Effect.sync(() => world.observations.get(processId) ?? { kind: 'absent' as const }),
  });
  return Layer.mergeAll(
    Layer.succeed(RepositoryLeaseStore, store),
    Layer.succeed(RepositoryHostIdentity, identity),
  );
}

interface SeedLeaseOverrides {
  readonly ownerId?: string;
  readonly hostIdentity?: string;
  readonly processId?: number;
  readonly processStartIdentity?: string | null;
  readonly acquiredAt?: string;
  readonly heartbeatAt?: string;
  readonly expiresAt?: string;
}

interface SeedGuardOverrides {
  readonly ownerId?: string;
  readonly hostIdentity?: string;
  readonly processId?: number;
  readonly processStartIdentity?: string | null;
  readonly acquiredAt?: string;
}

function seedText(world: FakeLeaseWorld, path: string, text: string): void {
  world.files.set(path, encoder.encode(text));
}

function seedLease(world: FakeLeaseWorld, overrides?: SeedLeaseOverrides): void {
  seedText(
    world,
    LEASE_PATH,
    `${JSON.stringify({
      schemaVersion: 1,
      ownerId: FIRST_OWNER_ID,
      hostIdentity: HOST_IDENTITY,
      processId: OWNER_PROCESS_ID,
      processStartIdentity: OWNER_START_IDENTITY,
      acquiredAt: '1969-12-31T23:58:00.000Z',
      heartbeatAt: '1969-12-31T23:58:00.000Z',
      expiresAt: EXPIRED_AT,
      ...overrides,
    })}\n`,
  );
}

function seedGuard(world: FakeLeaseWorld, overrides?: SeedGuardOverrides): void {
  seedText(
    world,
    GUARD_PATH,
    `${JSON.stringify({
      schemaVersion: 1,
      ownerId: FIRST_OWNER_ID,
      hostIdentity: HOST_IDENTITY,
      processId: OWNER_PROCESS_ID,
      processStartIdentity: OWNER_START_IDENTITY,
      acquiredAt: '1969-12-31T23:58:00.000Z',
      ...overrides,
    })}\n`,
  );
}

function leaseRecordOf(world: FakeLeaseWorld): RepositoryLeaseRecord {
  const bytes = world.files.get(LEASE_PATH);
  if (bytes === undefined) {
    throw new Error('The fake repository lease is missing.');
  }
  return Schema.decodeUnknownSync(RepositoryLeaseJson, { onExcessProperty: 'error' })(
    new TextDecoder('utf-8').decode(bytes),
  );
}

function acquireWith(world: FakeLeaseWorld, runId = 'RUN-A', leaseMs = 60000) {
  return acquireRepositoryLease({ repositoryRoot: REPOSITORY_ROOT, runId, leaseMs }).pipe(
    Effect.provide(leaseWorldLayer(world)),
  );
}

describe('repository lease owner classification', () => {
  it('treats only a verified dead local process instance as dead', () => {
    const owner = {
      hostIdentity: HOST_IDENTITY,
      processId: OWNER_PROCESS_ID,
      processStartIdentity: OWNER_START_IDENTITY,
    };

    expect(
      classifyRepositoryLeaseOwner(owner, HOST_IDENTITY, {
        kind: 'running',
        startIdentity: OWNER_START_IDENTITY,
      }),
    ).toBe('live');
    expect(
      classifyRepositoryLeaseOwner(owner, HOST_IDENTITY, {
        kind: 'running',
        startIdentity: 'linux:boot:43',
      }),
    ).toBe('dead');
    expect(classifyRepositoryLeaseOwner(owner, HOST_IDENTITY, { kind: 'absent' })).toBe('dead');
    expect(
      classifyRepositoryLeaseOwner(owner, HOST_IDENTITY, {
        kind: 'running',
        startIdentity: null,
      }),
    ).toBe('unverifiable');
    expect(
      classifyRepositoryLeaseOwner({ ...owner, processStartIdentity: null }, HOST_IDENTITY, {
        kind: 'running',
        startIdentity: OWNER_START_IDENTITY,
      }),
    ).toBe('unverifiable');
    expect(
      classifyRepositoryLeaseOwner(owner, HOST_IDENTITY, {
        kind: 'unavailable',
        detail: 'no process table',
      }),
    ).toBe('unverifiable');
    expect(
      classifyRepositoryLeaseOwner({ ...owner, hostIdentity: 'host-beta' }, HOST_IDENTITY, {
        kind: 'absent',
      }),
    ).toBe('unverifiable');
  });
});

describe('repository lease record contract', () => {
  it('accepts only closed, well-typed lease records', () => {
    const valid = {
      schemaVersion: 1,
      ownerId: FIRST_OWNER_ID,
      hostIdentity: HOST_IDENTITY,
      processId: OWNER_PROCESS_ID,
      processStartIdentity: OWNER_START_IDENTITY,
      acquiredAt: '1969-12-31T23:58:00.000Z',
      heartbeatAt: '1969-12-31T23:58:00.000Z',
      expiresAt: EXPIRED_AT,
    };
    const decode = (value: Schema.Json) =>
      Schema.decodeUnknownSync(RepositoryLeaseJson, { onExcessProperty: 'error' })(
        JSON.stringify(value),
      );

    expect(decode(valid)).toMatchObject({ ownerId: FIRST_OWNER_ID });
    for (const invalid of [
      { ...valid, extra: true },
      { ...valid, ownerId: 'not-a-uuid' },
      { ...valid, processId: -1 },
      { ...valid, processId: 1.5 },
      { ...valid, processStartIdentity: '' },
      { ...valid, expiresAt: 'yesterday' },
      { ...valid, heartbeatAt: '2020-13-45T99:99:99.999Z' },
      { ...valid, schemaVersion: 2 },
    ]) {
      expect(() => decode(invalid), JSON.stringify(invalid)).toThrow();
    }
  });

  it('accepts only closed, well-typed guard records', () => {
    const decode = (value: Schema.Json) =>
      Schema.decodeUnknownSync(RepositoryLeaseGuardJson, { onExcessProperty: 'error' })(
        JSON.stringify(value),
      );

    expect(
      decode({
        schemaVersion: 1,
        ownerId: FIRST_OWNER_ID,
        hostIdentity: HOST_IDENTITY,
        processId: OWNER_PROCESS_ID,
        processStartIdentity: null,
        acquiredAt: '1969-12-31T23:58:00.000Z',
      }),
    ).toMatchObject({ ownerId: FIRST_OWNER_ID });
    expect(() =>
      decode({
        schemaVersion: 1,
        ownerId: FIRST_OWNER_ID,
        hostIdentity: HOST_IDENTITY,
        processId: OWNER_PROCESS_ID,
        processStartIdentity: null,
        acquiredAt: '1969-12-31T23:58:00.000Z',
        heartbeatAt: '1969-12-31T23:58:00.000Z',
      }),
    ).toThrow();
  });
});

describe('repository lease acquisition', () => {
  it.effect('records a lease and denies a competing owner while it is healthy', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const first = yield* acquireWith(world, 'RUN-FIRST');
      expect(world.files.has(GUARD_PATH)).toBe(false);

      const record = leaseRecordOf(world);
      expect(record.ownerId).toBe(first.ownerId);
      expect(DateTime.toEpochMillis(record.expiresAt)).toBe(60000);
      expect(record.hostIdentity).toBe(HOST_IDENTITY);
      expect(record.processId).toBe(OWNER_PROCESS_ID);

      const before = world.files.get(LEASE_PATH);
      const failure = yield* acquireWith(world, 'RUN-SECOND').pipe(Effect.flip);
      expect(failure).toBeInstanceOf(RepositoryLeaseContended);
      expect(world.files.get(LEASE_PATH)).toEqual(before);
    }),
  );

  it.effect('takes over an expired lease only after the owner process instance is dead', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      seedLease(world);
      world.observations.set(OWNER_PROCESS_ID, { kind: 'absent' });

      const lease = yield* acquireWith(world, 'RUN-TAKEOVER');
      const record = leaseRecordOf(world);
      expect(record.ownerId).toBe(lease.ownerId);
      expect(record.ownerId).not.toBe(FIRST_OWNER_ID);
      expect(DateTime.toEpochMillis(record.expiresAt)).toBe(60000);
    }),
  );

  it.effect('takes over an expired lease whose PID was reused by another instance', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      seedLease(world);
      world.observations.set(OWNER_PROCESS_ID, {
        kind: 'running',
        startIdentity: 'linux:boot:99',
      });

      const lease = yield* acquireWith(world, 'RUN-REUSED');
      expect(leaseRecordOf(world).ownerId).toBe(lease.ownerId);
    }),
  );

  it.effect('blocks an expired lease whose owner process is still live', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      seedLease(world);

      const failure = yield* acquireWith(world, 'RUN-LIVE').pipe(Effect.flip);
      expect(failure).toBeInstanceOf(RepositoryLeaseContended);
      expect(failure.message).toContain('still running');
      expect(leaseRecordOf(world).ownerId).toBe(FIRST_OWNER_ID);
    }),
  );

  it.effect('fails closed for unverifiable, foreign, and corrupt expired leases', () =>
    Effect.gen(function* () {
      const unverifiable = makeWorld();
      seedLease(unverifiable);
      unverifiable.observations.set(OWNER_PROCESS_ID, {
        kind: 'unavailable',
        detail: 'no process table',
      });
      const unverifiableFailure = yield* acquireWith(unverifiable, 'RUN-UNVERIFIABLE').pipe(
        Effect.flip,
      );
      expect(unverifiableFailure).toBeInstanceOf(RepositoryLeaseAmbiguous);
      expect(unverifiableFailure.message).toContain('not verifiably dead');

      const foreign = makeWorld();
      seedLease(foreign, { hostIdentity: 'host-beta' });
      foreign.observations.set(OWNER_PROCESS_ID, { kind: 'absent' });
      const foreignFailure = yield* acquireWith(foreign, 'RUN-FOREIGN').pipe(Effect.flip);
      expect(foreignFailure).toBeInstanceOf(RepositoryLeaseAmbiguous);
      expect(foreignFailure.message).toContain('not verifiably dead');

      const corrupt = makeWorld();
      seedText(corrupt, LEASE_PATH, '{"schemaVersion": 1');
      const before = corrupt.files.get(LEASE_PATH);
      const corruptFailure = yield* acquireWith(corrupt, 'RUN-CORRUPT').pipe(Effect.flip);
      expect(corruptFailure).toBeInstanceOf(RepositoryLeaseAmbiguous);
      expect(corruptFailure.message).toContain('not a valid closed record');
      expect(corrupt.files.get(LEASE_PATH)).toEqual(before);
    }),
  );
});

describe('repository lease renewal and release', () => {
  it.effect('renews only for the current owner and releases only its own record', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const lease = yield* acquireWith(world, 'RUN-OWNER');
      expect(leaseRecordOf(world).ownerId).toBe(lease.ownerId);

      yield* TestClock.adjust(Duration.millis(1000));
      const renewed = yield* lease.renew;
      expect(renewed.ownerId).toBe(lease.ownerId);
      expect(DateTime.toEpochMillis(renewed.heartbeatAt)).toBe(1000);
      expect(DateTime.toEpochMillis(renewed.expiresAt)).toBe(61000);

      yield* lease.release;
      expect(world.files.has(LEASE_PATH)).toBe(false);
      yield* lease.release;
      expect(world.files.has(LEASE_PATH)).toBe(false);
    }),
  );

  it.effect('never lets a stale owner renew or remove a successor lease', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const lease = yield* acquireWith(world, 'RUN-STALE');

      const successor = {
        schemaVersion: 1,
        ownerId: SUCCESSOR_OWNER_ID,
        hostIdentity: 'host-beta',
        processId: 7777,
        processStartIdentity: 'linux:boot:77',
        acquiredAt: '1970-01-01T00:00:01.000Z',
        heartbeatAt: '1970-01-01T00:00:01.000Z',
        expiresAt: FRESH_EXPIRY,
      };
      seedText(world, LEASE_PATH, `${JSON.stringify(successor)}\n`);
      const before = world.files.get(LEASE_PATH);

      const renewal = yield* lease.renew.pipe(Effect.flip);
      expect(renewal).toBeInstanceOf(RepositoryLeaseOwnershipLost);
      expect(renewal.message).toContain('now held by');
      expect(world.files.get(LEASE_PATH)).toEqual(before);

      yield* lease.release;
      expect(world.files.get(LEASE_PATH)).toEqual(before);
    }),
  );

  it.effect('reports ownership loss when the lease record disappears', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const lease = yield* acquireWith(world, 'RUN-GONE');
      world.files.delete(LEASE_PATH);

      const renewal = yield* lease.renew.pipe(Effect.flip);
      expect(renewal).toBeInstanceOf(RepositoryLeaseOwnershipLost);
    }),
  );
});

describe('repository lease guard recovery', () => {
  it.effect('recovers a guard left by a confirmed-dead process instance', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      seedGuard(world, {
        processId: OWNER_PROCESS_ID,
        processStartIdentity: 'linux:boot:41',
      });

      const lease = yield* acquireWith(world, 'RUN-RECOVER');
      expect(lease.ownerId).toBeDefined();
      expect(world.files.has(GUARD_PATH)).toBe(false);
      expect(leaseRecordOf(world).ownerId).toBe(lease.ownerId);
    }),
  );

  it.effect('keeps a live guard holder blocking', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      seedGuard(world);
      const before = world.files.get(GUARD_PATH);

      const fiber = yield* acquireWith(world, 'RUN-BLOCKED').pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(10));
      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(failure).toBeInstanceOf(RepositoryLeaseContended);
      expect(failure.message).toContain('guard');
      expect(world.files.get(GUARD_PATH)).toEqual(before);
    }),
  );

  it.effect('fails closed on an unverifiable or corrupt guard', () =>
    Effect.gen(function* () {
      const foreign = makeWorld();
      seedGuard(foreign, { hostIdentity: 'host-beta' });
      const foreignFiber = yield* acquireWith(foreign, 'RUN-FOREIGN-GUARD').pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(10));
      const foreignFailure = yield* Fiber.join(foreignFiber).pipe(Effect.flip);
      expect(foreignFailure).toBeInstanceOf(RepositoryLeaseAmbiguous);
      expect(foreignFailure.message).toContain('unverifiable owner');
      expect(foreign.files.has(GUARD_PATH)).toBe(true);

      const corrupt = makeWorld();
      seedText(corrupt, GUARD_PATH, '{not json');
      const corruptFiber = yield* acquireWith(corrupt, 'RUN-CORRUPT-GUARD').pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(10));
      const corruptFailure = yield* Fiber.join(corruptFiber).pipe(Effect.flip);
      expect(corruptFailure).toBeInstanceOf(RepositoryLeaseAmbiguous);
      expect(corruptFailure.message).toContain('not a valid record');
      expect(corrupt.files.has(GUARD_PATH)).toBe(true);
    }),
  );
});

describe('scoped repository lease ownership', () => {
  it.effect('renews before half the lease duration and releases when interrupted', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const fiber = yield* withRepositoryLease(
        { repositoryRoot: REPOSITORY_ROOT, runId: 'RUN-HEARTBEAT', leaseMs: 3000 },
        () => Effect.never,
      ).pipe(Effect.provide(leaseWorldLayer(world)), Effect.forkChild);

      yield* Effect.yieldNow;
      expect(world.files.has(LEASE_PATH)).toBe(true);

      yield* TestClock.adjust(Duration.millis(999));
      expect(DateTime.toEpochMillis(leaseRecordOf(world).heartbeatAt)).toBe(0);

      yield* TestClock.adjust(Duration.millis(1));
      expect(DateTime.toEpochMillis(leaseRecordOf(world).heartbeatAt)).toBe(1000);
      expect(DateTime.toEpochMillis(leaseRecordOf(world).expiresAt)).toBe(4000);

      yield* Fiber.interrupt(fiber);
      expect(world.files.has(LEASE_PATH)).toBe(false);
    }),
  );

  it.effect('releases the lease when the operation fails', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const error = yield* withRepositoryLease(
        { repositoryRoot: REPOSITORY_ROOT, runId: 'RUN-FAIL', leaseMs: 3000 },
        () => Effect.fail('operation failed'),
      ).pipe(Effect.provide(leaseWorldLayer(world)), Effect.flip);

      expect(error).toBe('operation failed');
      expect(world.files.has(LEASE_PATH)).toBe(false);
      expect(world.files.has(GUARD_PATH)).toBe(false);
    }),
  );

  it.effect('stops repository writes when renewal fails', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const writes: Array<string> = [];
      const fiber = yield* withRepositoryLease(
        { repositoryRoot: REPOSITORY_ROOT, runId: 'RUN-LOST', leaseMs: 3000 },
        () =>
          Effect.gen(function* () {
            for (const step of ['a', 'b', 'c', 'd']) {
              yield* Effect.sleep(Duration.millis(400));
              writes.push(step);
            }
            return 'completed';
          }),
      ).pipe(Effect.provide(leaseWorldLayer(world)), Effect.forkChild);

      yield* Effect.yieldNow;
      world.writeFailure = new RepositoryLeaseStorageError({
        message: 'the lease disk went away',
      });
      yield* TestClock.adjust(Duration.millis(1000));

      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(RepositoryLeaseStorageError);
      expect(writes).toEqual(['a', 'b']);
      expect(world.files.has(LEASE_PATH)).toBe(false);
    }),
  );

  it.effect('passes the operation result through and releases the lease', () =>
    Effect.gen(function* () {
      const world = makeWorld();
      const result = yield* withRepositoryLease(
        { repositoryRoot: REPOSITORY_ROOT, runId: 'RUN-OK', leaseMs: 3000 },
        () => Effect.succeed('operation result'),
      ).pipe(Effect.provide(leaseWorldLayer(world)));

      expect(result).toBe('operation result');
      expect(world.files.has(LEASE_PATH)).toBe(false);
      expect(world.files.has(GUARD_PATH)).toBe(false);
    }),
  );
});
