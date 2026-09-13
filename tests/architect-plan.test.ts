import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ArchitectPlanRejected,
  acceptArchitectPlan,
} from '../src/application/architect-plan/index.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { transitionWorkflow } from '../src/application/workflow-transitions/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import {
  ArchitectPlanControlSchema,
  ARCHITECT_PLAN_SCHEMA_VERSION,
  compileExecutionPlan,
  decodeArchitectPlanControl,
  labelAcceptanceCriteria,
  normalizeRepositoryPath,
} from '../src/domain/architect-plan.js';

import type { ArchitectPlanControl } from '../src/domain/architect-plan.js';

const RUN_ID = 'RUN-PLAN';

const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const TASK_BRANCH = 'foundry/RUN-PLAN';

const WORKSPACE = '/target/.agent/worktrees/RUN-PLAN';

const LiveStore = Layer.mergeAll(RunIdentityLive, RunHistoryLive);

const PARSE_OPTIONS = { onExcessProperty: 'error' } as const;

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-architect-plan-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

function seedPlanning(fixture: Fixture) {
  return Effect.gen(function* () {
    yield* appendRunEvent({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      createIfMissing: true,
      build: () =>
        Effect.succeed({ type: 'run-created', payload: { taskId: 'TASK-PLAN' } } as const),
    });
    yield* appendRunEvent({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'source-frozen',
          payload: {
            repository: {
              repositoryRoot: '/target',
              gitDirectory: '/target/.git',
              remoteUrl: 'https://example.invalid/target.git',
            },
            sourceRemote: 'origin',
            sourceBranch: 'main',
            sourceCommit: FROZEN_COMMIT,
            taskBranch: TASK_BRANCH,
            workspace: WORKSPACE,
            expectedHead: FROZEN_COMMIT,
          },
        } as const),
    });
    yield* appendRunEvent({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'guidance-frozen',
          payload: {
            sourceCommit: FROZEN_COMMIT,
            manifestPath: 'guidance-manifest.json',
            aggregateHash: 'f'.repeat(64),
            files: [],
          },
        } as const),
    });
    yield* appendRunEvent({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'worktree-ready',
          payload: {
            taskBranch: TASK_BRANCH,
            workspace: WORKSPACE,
            headCommit: FROZEN_COMMIT,
            baseCommit: FROZEN_COMMIT,
          },
        } as const),
    });
    yield* transitionWorkflow({
      runDirectory: fixture.runDirectory,
      runId: RUN_ID,
      request: {
        route: 'run-created',
        provisioning: { source: true, lease: true, storage: true, worktree: true },
      },
    });
  }).pipe(Effect.provide(observingGit()), Effect.provide(LiveStore));
}

function observingGit() {
  const unused = (name: string) => Effect.die(new Error(`plan tests must not call RunGit.${name}`));
  return Layer.succeed(
    RunGit,
    RunGit.of({
      inspectRepository: () => unused('inspectRepository'),
      fetchSource: () => unused('fetchSource'),
      commitExists: () => unused('commitExists'),
      readBranch: () => unused('readBranch'),
      createBranch: () => unused('createBranch'),
      readWorktree: () => unused('readWorktree'),
      createWorktree: () => unused('createWorktree'),
      observeImplementation: () => unused('observeImplementation'),
    }),
  );
}

function readPlan(runDirectory: string) {
  return readVerifiedRunHistory({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(
    Effect.provide(RunHistoryLive),
    Effect.map((history) => history.derived.acceptedPlan),
  );
}

const PLAN_READY: ArchitectPlanControl = {
  schemaVersion: ARCHITECT_PLAN_SCHEMA_VERSION,
  outcome: 'plan_ready',
  acceptanceCriteria: ['Each role may only do its job.', 'Only Coder changes files.'],
  runtimeValidation: 'not_required',
  execution: 'sequential',
};

describe('architect plan control contract', () => {
  it('decodes the three closed outcomes and rejects open or malformed envelopes', () => {
    expect(
      Schema.decodeUnknownSync(ArchitectPlanControlSchema, PARSE_OPTIONS)(PLAN_READY),
    ).toMatchObject({ outcome: 'plan_ready' });
    expect(
      Schema.decodeUnknownSync(
        ArchitectPlanControlSchema,
        PARSE_OPTIONS,
      )({
        schemaVersion: 1,
        outcome: 'no_change_candidate',
        acceptanceCriteria: ['nothing to do'],
        runtimeValidation: 'not_required',
      }),
    ).toMatchObject({ outcome: 'no_change_candidate' });
    expect(
      Schema.decodeUnknownSync(
        ArchitectPlanControlSchema,
        PARSE_OPTIONS,
      )({
        schemaVersion: 1,
        outcome: 'blocked',
      }),
    ).toEqual({ schemaVersion: 1, outcome: 'blocked' });

    const invalidControls: ReadonlyArray<Schema.Json> = [
      { ...PLAN_READY, extra: true },
      { ...PLAN_READY, outcome: 'maybe' },
      { ...PLAN_READY, runtimeValidation: 'perhaps' },
      {
        schemaVersion: 1,
        outcome: 'plan_ready',
        acceptanceCriteria: ['x'],
        runtimeValidation: 'required',
      },
      { schemaVersion: 1, outcome: 'blocked', acceptanceCriteria: ['x'] },
    ];
    for (const invalid of invalidControls) {
      expect(decodeArchitectPlanControl(invalid).ok, JSON.stringify(invalid)).toBe(false);
    }
  });

  it('labels criteria in order without paraphrasing the operator', () => {
    expect(labelAcceptanceCriteria(['  keep my words  ', 'second'])).toEqual([
      { id: 'AC-001', text: 'keep my words' },
      { id: 'AC-002', text: 'second' },
    ]);
  });

  it('normalizes repository-relative path prefixes and rejects unsafe paths', () => {
    expect(normalizeRepositoryPath('src/foo/')).toBe('src/foo');
    expect(normalizeRepositoryPath('./src//bar')).toBe('src/bar');
    expect(normalizeRepositoryPath('.')).toBe('.');
    expect(normalizeRepositoryPath('/etc')).toBeNull();
    expect(normalizeRepositoryPath('C:/x')).toBeNull();
    expect(normalizeRepositoryPath('src/../etc')).toBeNull();
    expect(normalizeRepositoryPath('src/*.ts')).toBeNull();
    expect(normalizeRepositoryPath('src\\win')).toBeNull();
  });
});

describe('architect execution compilation', () => {
  it('defaults to one sequential objective covering every criterion', () => {
    const plan = compileExecutionPlan(PLAN_READY);
    expect(plan.mode).toBe('sequential');
    expect(plan.objectives).toHaveLength(1);
    expect(plan.objectives[0]?.id).toBe('OBJ-001');
    expect(plan.objectives[0]?.criterionIds).toEqual(['AC-001', 'AC-002']);
    expect(plan.objectives[0]?.affectedPaths).toEqual(['.']);
  });

  it('accepts a complete, independent, non-overlapping parallel split', () => {
    const plan = compileExecutionPlan({
      schemaVersion: 1,
      outcome: 'plan_ready',
      acceptanceCriteria: ['a', 'b', 'c'],
      runtimeValidation: 'required',
      execution: 'parallel',
      affectedPaths: ['src'],
      objectives: [
        { title: 'first', affectedPaths: ['src/one'], criteria: [1, 2] },
        { title: 'second', affectedPaths: ['src/two'], criteria: [3] },
      ],
    });
    expect(plan.mode).toBe('parallel');
    expect(plan.objectives.map((objective) => objective.id)).toEqual(['OBJ-001', 'OBJ-002']);
    expect(plan.objectives.map((objective) => objective.criterionIds)).toEqual([
      ['AC-001', 'AC-002'],
      ['AC-003'],
    ]);
  });

  it('falls back to sequential for unsafe, overlapping, incomplete, or duplicate metadata', () => {
    const base = {
      schemaVersion: 1 as const,
      outcome: 'plan_ready' as const,
      acceptanceCriteria: ['a', 'b'],
      runtimeValidation: 'not_required' as const,
      execution: 'parallel' as const,
    };
    const unsafe: ReadonlyArray<ArchitectPlanControl> = [
      base,
      {
        ...base,
        objectives: [{ title: 'only one', affectedPaths: ['src'], criteria: [1] }],
      },
      {
        ...base,
        objectives: [
          { title: 'left', affectedPaths: ['.'], criteria: [1] },
          { title: 'right', affectedPaths: ['src'], criteria: [2] },
        ],
      },
      {
        ...base,
        objectives: [
          { title: 'one', affectedPaths: ['src/one'], criteria: [1] },
          { title: 'two', affectedPaths: ['src/two'], criteria: [1] },
        ],
      },
      {
        ...base,
        objectives: [
          { title: 'one', affectedPaths: ['src/one'], criteria: [1] },
          { title: 'two', affectedPaths: ['src/two'], criteria: [] },
        ],
      },
      {
        ...base,
        objectives: [
          { title: 'one', affectedPaths: ['src/../etc'], criteria: [1] },
          { title: 'two', affectedPaths: ['src/two'], criteria: [2] },
        ],
      },
    ];
    expect(compileExecutionPlan(unsafe[0]!).mode).toBe('sequential');
    for (const control of unsafe.slice(1)) {
      const plan = compileExecutionPlan(control);
      expect(plan.mode).toBe('sequential');
      expect(plan.objectives).toHaveLength(1);
      expect(plan.objectives[0]?.criterionIds).toEqual(['AC-001', 'AC-002']);
    }
  });
});

describe('architect plan acceptance', () => {
  it.effect('accepts a ready plan and retains criteria and routing facts', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedPlanning(fixture);
        const result = yield* acceptArchitectPlan({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          control: PLAN_READY,
          controlRepairsRemaining: 1,
          retriesRemaining: 1,
          repairReason: 'repair',
          retryReason: 'retry',
        }).pipe(Effect.provide(LiveStore));

        expect(result.outcome).toBe('accepted');
        if (result.outcome === 'accepted') {
          expect(result.plan.runtimeValidationRequired).toBe(false);
          expect(result.plan.requiresImplementation).toBe(true);
          expect(result.plan.criteria).toEqual([
            { id: 'AC-001', text: 'Each role may only do its job.' },
            { id: 'AC-002', text: 'Only Coder changes files.' },
          ]);
        }
        const plan = yield* readPlan(fixture.runDirectory);
        expect(plan?.outcome).toBe('plan_ready');
        expect(plan?.criteria.map((criterion) => criterion.id)).toEqual(['AC-001', 'AC-002']);
        expect(plan?.execution.mode).toBe('sequential');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('spends at most one repair before the retry budget and never invents a plan', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedPlanning(fixture);
        const invalid = { schemaVersion: 1, outcome: 'plan_ready' };

        const repair = yield* acceptArchitectPlan({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          control: invalid,
          controlRepairsRemaining: 1,
          retriesRemaining: 1,
          repairReason: 'repair',
          retryReason: 'retry',
        }).pipe(Effect.provide(LiveStore));
        expect(repair.outcome).toBe('repair-required');

        const retry = yield* acceptArchitectPlan({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          control: invalid,
          controlRepairsRemaining: 0,
          retriesRemaining: 1,
          repairReason: 'repair',
          retryReason: 'retry',
        }).pipe(Effect.provide(LiveStore));
        expect(retry.outcome).toBe('retry-required');

        const error = yield* acceptArchitectPlan({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          control: invalid,
          controlRepairsRemaining: 0,
          retriesRemaining: 0,
          repairReason: 'repair',
          retryReason: 'retry',
        }).pipe(Effect.provide(LiveStore), Effect.flip);
        expect(error).toBeInstanceOf(ArchitectPlanRejected);

        const plan = yield* readPlan(fixture.runDirectory);
        expect(plan).toBeNull();
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('returns blocked without recording a plan', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedPlanning(fixture);
        const result = yield* acceptArchitectPlan({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          control: { schemaVersion: 1, outcome: 'blocked' },
          controlRepairsRemaining: 1,
          retriesRemaining: 1,
          repairReason: 'repair',
          retryReason: 'retry',
        }).pipe(Effect.provide(LiveStore));
        expect(result.outcome).toBe('blocked');
        expect(yield* readPlan(fixture.runDirectory)).toBeNull();
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
