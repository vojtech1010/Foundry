import { describe, expect, it } from '@effect/vitest';
import { Duration, Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RepositoryLeaseAmbiguous,
  RepositoryLeaseContended,
  acquireRepositoryLease,
} from '../../src/application/repository-lease/index.js';
import {
  REPOSITORY_LEASE_FILENAME,
  REPOSITORY_LEASE_GUARD_FILENAME,
} from '../../src/domain/repository-lease.js';
import { RepositoryLeaseLive } from '../../src/platform/repository-lease.js';

const SEEDED_OWNER_ID = '11111111-1111-4111-8111-111111111111';

const NOW = '1969-12-31T23:58:00.000Z';

const EXPIRED_AT = '1969-12-31T23:59:59.000Z';

const ReadLeaseJson = Schema.fromJsonString(
  Schema.Struct({ ownerId: Schema.String, processId: Schema.Int }),
);

function storageDirectory(root: string): string {
  return join(root, '.agent');
}

function withRoot<A, E, R>(use: (root: string) => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const root = mkdtempSync(join(tmpdir(), 'foundry-parity-lease-'));
  return use(root).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        rmSync(root, { recursive: true, force: true });
      }),
    ),
  );
}

function acquire(root: string, runId: string, leaseMs = 60_000) {
  return acquireRepositoryLease({ repositoryRoot: root, runId, leaseMs }).pipe(
    Effect.provide(RepositoryLeaseLive),
  );
}

function seedLease(
  root: string,
  overrides: { readonly processId?: number; readonly processStartIdentity?: string | null } = {},
): void {
  const directory = storageDirectory(root);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, REPOSITORY_LEASE_FILENAME),
    `${JSON.stringify({
      schemaVersion: 1,
      ownerId: SEEDED_OWNER_ID,
      hostIdentity: hostname(),
      processId: overrides.processId ?? 999_999,
      processStartIdentity: overrides.processStartIdentity ?? null,
      acquiredAt: NOW,
      heartbeatAt: NOW,
      expiresAt: EXPIRED_AT,
    })}\n`,
  );
}

function seedGuard(root: string, processId: number): void {
  const directory = storageDirectory(root);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, REPOSITORY_LEASE_GUARD_FILENAME),
    `${JSON.stringify({
      schemaVersion: 1,
      ownerId: SEEDED_OWNER_ID,
      hostIdentity: hostname(),
      processId,
      processStartIdentity: null,
      acquiredAt: NOW,
    })}\n`,
  );
}

function readLeaseOwnerId(root: string): string {
  return Schema.decodeUnknownSync(ReadLeaseJson)(
    readFileSync(join(storageDirectory(root), REPOSITORY_LEASE_FILENAME), 'utf8'),
  ).ownerId;
}

function readLeaseProcessId(root: string): number {
  return Schema.decodeUnknownSync(ReadLeaseJson)(
    readFileSync(join(storageDirectory(root), REPOSITORY_LEASE_FILENAME), 'utf8'),
  ).processId;
}

function deadProcessId(): number {
  const outcome = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  if (outcome.pid === undefined) {
    throw new Error('Could not isolate an exited process id for the parity fixture.');
  }
  return outcome.pid;
}

describe('repository lock recovery parity', () => {
  it.effect('denies a competing owner while the recorded owner is healthy', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        yield* acquire(root, 'RUN-HEALTHY');
        const failure = yield* acquire(root, 'RUN-COMPETING').pipe(Effect.flip);
        expect(failure).toBeInstanceOf(RepositoryLeaseContended);
      }),
    ),
  );

  it.effect('classifies an expired lease owned by this process per platform liveness', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        yield* acquire(root, 'RUN-LIVE-OWNER');
        yield* TestClock.adjust(Duration.millis(120_000));
        const failure = yield* acquire(root, 'RUN-LIVE-OWNER-NEXT').pipe(Effect.flip);

        if (process.platform === 'linux') {
          expect(failure).toBeInstanceOf(RepositoryLeaseContended);
          expect(failure.message).toContain('still running');
        } else {
          expect(failure).toBeInstanceOf(RepositoryLeaseAmbiguous);
          expect(failure.message).toContain('not verifiably dead');
        }
      }),
    ),
  );

  it.effect('takes over an expired lease only when its recorded process is gone', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        seedLease(root, { processId: deadProcessId(), processStartIdentity: null });
        const lease = yield* acquire(root, 'RUN-TAKEOVER');
        expect(readLeaseOwnerId(root)).toBe(lease.ownerId);
        expect(readLeaseOwnerId(root)).not.toBe(SEEDED_OWNER_ID);
        expect(readLeaseProcessId(root)).toBe(process.pid);
      }),
    ),
  );

  it.effect('treats a reused pid as a dead owner when the start identity differs', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        if (process.platform !== 'linux') {
          return;
        }
        seedLease(root, { processId: process.pid, processStartIdentity: 'linux:parity:0' });
        const lease = yield* acquire(root, 'RUN-REUSED-PID');
        expect(readLeaseOwnerId(root)).toBe(lease.ownerId);
        expect(readLeaseProcessId(root)).toBe(process.pid);
      }),
    ),
  );

  it.effect('recovers a stale lease guard left by a dead process', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        seedGuard(root, deadProcessId());
        const lease = yield* acquire(root, 'RUN-STALE-GUARD');
        expect(lease.ownerId).toBeDefined();
        expect(existsSync(join(storageDirectory(root), REPOSITORY_LEASE_GUARD_FILENAME))).toBe(
          false,
        );
      }),
    ),
  );
});
