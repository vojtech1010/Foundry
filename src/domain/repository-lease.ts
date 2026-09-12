import { DateTime, Schema } from 'effect';

export const REPOSITORY_LEASE_SCHEMA_VERSION = 1 as const;

export const REPOSITORY_LEASE_FILENAME = 'repository-lease.json' as const;

export const REPOSITORY_LEASE_GUARD_FILENAME = 'repository-lease.guard' as const;

export interface RepositoryLeaseOwnerIdentity {
  readonly hostIdentity: string;
  readonly processId: number;
  readonly processStartIdentity: string | null;
}

const OwnerIdentityFields = {
  ownerId: Schema.String.check(Schema.isUUID()),
  hostIdentity: Schema.NonEmptyString,
  processId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  processStartIdentity: Schema.NullOr(Schema.NonEmptyString),
};

export const RepositoryLeaseRecordSchema = Schema.Struct({
  schemaVersion: Schema.Literal(REPOSITORY_LEASE_SCHEMA_VERSION),
  ...OwnerIdentityFields,
  acquiredAt: Schema.DateTimeUtcFromString,
  heartbeatAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});

export type RepositoryLeaseRecord = (typeof RepositoryLeaseRecordSchema)['Type'];

export const RepositoryLeaseGuardRecordSchema = Schema.Struct({
  schemaVersion: Schema.Literal(REPOSITORY_LEASE_SCHEMA_VERSION),
  ...OwnerIdentityFields,
  acquiredAt: Schema.DateTimeUtcFromString,
});

export type RepositoryLeaseGuardRecord = (typeof RepositoryLeaseGuardRecordSchema)['Type'];

export const RepositoryLeaseJson = Schema.fromJsonString(RepositoryLeaseRecordSchema);

export const RepositoryLeaseGuardJson = Schema.fromJsonString(RepositoryLeaseGuardRecordSchema);

export type LocalProcessObservation =
  | { readonly kind: 'running'; readonly startIdentity: string | null }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable'; readonly detail: string };

export type RepositoryLeaseOwnerLiveness = 'live' | 'dead' | 'unverifiable';

export function classifyRepositoryLeaseOwner(
  owner: RepositoryLeaseOwnerIdentity,
  localHostIdentity: string,
  observation: LocalProcessObservation,
): RepositoryLeaseOwnerLiveness {
  if (owner.hostIdentity !== localHostIdentity) {
    return 'unverifiable';
  }
  switch (observation.kind) {
    case 'absent':
      return 'dead';
    case 'unavailable':
      return 'unverifiable';
    case 'running':
      if (owner.processStartIdentity === null || observation.startIdentity === null) {
        return 'unverifiable';
      }
      return owner.processStartIdentity === observation.startIdentity ? 'live' : 'dead';
  }
}

export function repositoryLeaseExpired(record: RepositoryLeaseRecord, now: DateTime.Utc): boolean {
  return DateTime.toEpochMillis(record.expiresAt) <= DateTime.toEpochMillis(now);
}

export function describeRepositoryLeaseOwner(owner: RepositoryLeaseOwnerIdentity): string {
  const identity =
    owner.processStartIdentity === null
      ? 'process start identity unavailable'
      : `process start identity ${owner.processStartIdentity}`;
  return `host "${owner.hostIdentity}", process ${owner.processId}, ${identity}`;
}
