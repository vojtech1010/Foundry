import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RoleHost } from '../src/application/role-conversations/index.js';
import {
  RolePermissionViolation,
  RoleTurnResourceObserver,
  startGovernedRoleTurn,
} from '../src/application/role-permissions/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { ROLE_HOST_PROTOCOL_VERSION } from '../src/domain/role-host.js';
import {
  deriveRoleHostAccessScope,
  environmentAllowlistProblems,
} from '../src/domain/role-permissions.js';

import type { RoleTurnResourceFingerprint } from '../src/application/role-permissions/index.js';
import type { RoleHostOperationalError } from '../src/application/role-conversations/index.js';
import type {
  RoleHostCreateResponse,
  RoleHostObserveResponse,
  RoleHostOperation,
  RoleHostRole,
  RoleHostSubmitResponse,
  RoleHostStopResponse,
} from '../src/domain/role-host.js';
import type { RoleTurnLocations } from '../src/domain/role-permissions.js';

const RUN_ID = 'RUN-PERMISSIONS';

const LOCATIONS: RoleTurnLocations = {
  projectRoot: '/target',
  runDirectory: '/target/.agent/runs/RUN-PERMISSIONS',
  scratchDirectory: '/target/.agent/runs/RUN-PERMISSIONS/scratch/architect/1',
  worktree: '/target/.agent/worktrees/RUN-PERMISSIONS',
  runtimeBaseUrl: 'http://127.0.0.1:4200/health',
};

const FIXTURE_IDENTITY = {
  adapterVersion: 'fake-1',
  provider: 'fake-provider',
  model: 'fake-model',
  toolProfile: 'fake-profile',
} as const;

const SETTLED_RESPONSE: RoleHostObserveResponse = {
  schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
  status: 'settled',
  sequence: 2,
  events: [{ sequence: 2, kind: 'message', text: 'finished' }],
  narrative: '# Result\n\nObserved.',
  control: { schemaVersion: 1, outcome: 'observed' },
};

interface FakeHost {
  readonly layer: Layer.Layer<RoleHost>;
  readonly calls: Array<RoleHostOperation>;
  readonly createDirectories: Array<string | undefined>;
}

function fakeRoleHost(): FakeHost {
  const calls: Array<RoleHostOperation> = [];
  const createDirectories: Array<string | undefined> = [];
  const layer = Layer.succeed(
    RoleHost,
    RoleHost.of({
      capabilities: () => Effect.die(new Error('capabilities is unused')),
      create: (request): Effect.Effect<RoleHostCreateResponse, RoleHostOperationalError> => {
        calls.push('create');
        createDirectories.push(request.workingDirectory);
        return Effect.succeed({
          schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          sessionId: 'session-1',
          ownershipToken: 'owner-1',
          generation: request.generation,
          sequence: 0,
          runtimeIdentity: FIXTURE_IDENTITY,
        });
      },
      submit: (): Effect.Effect<RoleHostSubmitResponse, RoleHostOperationalError> => {
        calls.push('submit');
        return Effect.succeed({
          schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          submission: 'accepted',
        });
      },
      observe: (): Effect.Effect<RoleHostObserveResponse, RoleHostOperationalError> => {
        calls.push('observe');
        return Effect.succeed(SETTLED_RESPONSE);
      },
      stop: (): Effect.Effect<RoleHostStopResponse, RoleHostOperationalError> => {
        calls.push('stop');
        return Effect.succeed({
          schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          disposition: 'disposed',
        });
      },
    }),
  );
  return { layer, calls, createDirectories };
}

function scriptedObserver(
  fingerprints: ReadonlyArray<RoleTurnResourceFingerprint>,
): Layer.Layer<RoleTurnResourceObserver> {
  let index = 0;
  return Layer.succeed(
    RoleTurnResourceObserver,
    RoleTurnResourceObserver.of({
      fingerprint: () => {
        const fingerprint = fingerprints[Math.min(index, fingerprints.length - 1)];
        index += 1;
        return Effect.succeed(
          fingerprint ?? { projectStatus: '', worktreeStatus: null, ownedResources: '' },
        );
      },
    }),
  );
}

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-role-permissions-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function seedRunCreated(runDirectory: string) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: true,
    build: () => Effect.succeed({ type: 'run-created', payload: { taskId: 'TASK-1' } } as const),
  }).pipe(Effect.provide(RunHistoryLive));
}

function governedOptions(
  runDirectory: string,
  role: RoleHostRole,
  locations: RoleTurnLocations = LOCATIONS,
) {
  return {
    runDirectory,
    runId: RUN_ID,
    role,
    attempt: 1,
    generation: 1,
    locations,
    environmentAllowlist: [],
    prompt: 'Do the job.',
    deadline: '2026-09-13T00:00:00.000Z',
    pollMs: 0,
    turnTimeoutMs: 60_000,
  };
}

describe('role host access scope derivation', () => {
  it('derives each role from run-owned locations and fails closed on missing bounds', () => {
    const architect = deriveRoleHostAccessScope('architect', LOCATIONS);
    expect(architect.ok).toBe(true);
    if (architect.ok) {
      expect(architect.scope.workingDirectory).toBe('/target');
      expect(architect.scope.writeRoots).toEqual([LOCATIONS.scratchDirectory]);
      expect(architect.scope.networkAllowlist).toEqual([]);
      expect(architect.scope.network).toEqual(['network_denied']);
    }

    const coder = deriveRoleHostAccessScope('coder', LOCATIONS);
    expect(coder.ok).toBe(true);
    if (coder.ok) {
      expect(coder.scope.workingDirectory).toBe(LOCATIONS.worktree);
      expect(coder.scope.writeRoots).toContain(LOCATIONS.worktree);
      expect(coder.scope.networkAllowlist).toEqual([]);
    }

    const tester = deriveRoleHostAccessScope('tester', LOCATIONS);
    expect(tester.ok).toBe(true);
    if (tester.ok) {
      expect(tester.scope.networkAllowlist).toEqual(['http://127.0.0.1:4200']);
    }

    const noWorktree = deriveRoleHostAccessScope('coder', { ...LOCATIONS, worktree: null });
    expect(noWorktree.ok).toBe(false);
    if (!noWorktree.ok) {
      expect(noWorktree.problem.kind).toBe('worktree-required');
    }

    const noOrigin = deriveRoleHostAccessScope('tester', { ...LOCATIONS, runtimeBaseUrl: null });
    expect(noOrigin.ok).toBe(false);
    if (!noOrigin.ok) {
      expect(noOrigin.problem.kind).toBe('runtime-origin-required');
    }
  });

  it('rejects invalid environment variable names without reading values', () => {
    expect(environmentAllowlistProblems(['TOKEN', 'A_B_1'])).toEqual([]);
    expect(environmentAllowlistProblems(['lower-case', '1START', 'has space'])).toHaveLength(3);
  });
});

describe('governed role turn', () => {
  it.effect('stops a read-only turn that mutates the project and records the violation', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedRunCreated(fixture.runDirectory);
        const host = fakeRoleHost();
        const observer = scriptedObserver([
          { projectStatus: '', worktreeStatus: null, ownedResources: '' },
          { projectStatus: ' M src/foo.ts', worktreeStatus: null, ownedResources: '' },
        ]);
        const error = yield* startGovernedRoleTurn(
          governedOptions(fixture.runDirectory, 'reviewer'),
        ).pipe(Effect.provide(Layer.mergeAll(RunHistoryLive, host.layer, observer)), Effect.flip);
        expect(error).toBeInstanceOf(RolePermissionViolation);
        if (error instanceof RolePermissionViolation) {
          expect(error.reason).toBe('project-mutation');
        }
        const history = yield* readVerifiedRunHistory({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(RunHistoryLive));
        expect(history.derived.permissionViolations).toHaveLength(1);
        expect(history.derived.permissionViolations[0]?.kind).toBe('project-mutation');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect(
    'stops a read-only turn that mutates run-owned resources and records the violation',
    () =>
      Effect.gen(function* () {
        const fixture = setupFixture();
        try {
          yield* seedRunCreated(fixture.runDirectory);
          const host = fakeRoleHost();
          const observer = scriptedObserver([
            { projectStatus: '', worktreeStatus: null, ownedResources: 'scratch/capture|0' },
            { projectStatus: '', worktreeStatus: null, ownedResources: 'scratch/capture|12' },
          ]);
          const error = yield* startGovernedRoleTurn(
            governedOptions(fixture.runDirectory, 'architect'),
          ).pipe(Effect.provide(Layer.mergeAll(RunHistoryLive, host.layer, observer)), Effect.flip);
          expect(error).toBeInstanceOf(RolePermissionViolation);
          if (error instanceof RolePermissionViolation) {
            expect(error.reason).toBe('run-resource-mutation');
          }
          const history = yield* readVerifiedRunHistory({
            runDirectory: fixture.runDirectory,
            runId: RUN_ID,
            createIfMissing: false,
          }).pipe(Effect.provide(RunHistoryLive));
          expect(history.derived.permissionViolations).toHaveLength(1);
          expect(history.derived.permissionViolations[0]?.kind).toBe('run-resource-mutation');
        } finally {
          fixture.cleanup();
        }
      }),
  );

  it.effect(
    'runs the settled turn without mutation and records the derived working directory',
    () =>
      Effect.gen(function* () {
        const fixture = setupFixture();
        try {
          yield* seedRunCreated(fixture.runDirectory);
          const host = fakeRoleHost();
          const observer = scriptedObserver([
            { projectStatus: '', worktreeStatus: null, ownedResources: '' },
            { projectStatus: '', worktreeStatus: null, ownedResources: '' },
          ]);
          const result = yield* startGovernedRoleTurn(
            governedOptions(fixture.runDirectory, 'architect'),
          ).pipe(Effect.provide(Layer.mergeAll(RunHistoryLive, host.layer, observer)));
          expect(result.outcome).toBe('settled');
          expect(host.createDirectories).toEqual(['/target']);

          const history = yield* readVerifiedRunHistory({
            runDirectory: fixture.runDirectory,
            runId: RUN_ID,
            createIfMissing: false,
          }).pipe(Effect.provide(RunHistoryLive));
          expect(history.derived.permissionViolations).toHaveLength(0);
        } finally {
          fixture.cleanup();
        }
      }),
  );

  it.effect('fails closed and records a violation when a bound cannot be derived', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedRunCreated(fixture.runDirectory);
        const host = fakeRoleHost();
        const observer = scriptedObserver([
          { projectStatus: '', worktreeStatus: null, ownedResources: '' },
        ]);
        const error = yield* startGovernedRoleTurn(
          governedOptions(fixture.runDirectory, 'tester', { ...LOCATIONS, runtimeBaseUrl: null }),
        ).pipe(Effect.provide(Layer.mergeAll(RunHistoryLive, host.layer, observer)), Effect.flip);
        expect(error).toBeInstanceOf(RolePermissionViolation);
        if (error instanceof RolePermissionViolation) {
          expect(error.reason).toBe('runtime-origin-required');
        }
        expect(host.calls).toEqual([]);
        const history = yield* readVerifiedRunHistory({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(RunHistoryLive));
        expect(history.derived.permissionViolations[0]?.kind).toBe('missing-enforcement');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses an invalid environment allowlist before touching the host', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedRunCreated(fixture.runDirectory);
        const host = fakeRoleHost();
        const observer = scriptedObserver([
          { projectStatus: '', worktreeStatus: null, ownedResources: '' },
        ]);
        const error = yield* startGovernedRoleTurn({
          ...governedOptions(fixture.runDirectory, 'architect'),
          environmentAllowlist: ['not-valid'],
        }).pipe(Effect.provide(Layer.mergeAll(RunHistoryLive, host.layer, observer)), Effect.flip);
        expect(error).toBeInstanceOf(RolePermissionViolation);
        if (error instanceof RolePermissionViolation) {
          expect(error.reason).toBe('invalid-environment-name');
        }
        expect(host.calls).toEqual([]);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
