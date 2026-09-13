import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordIntegrationCompleted,
  recordIntegrationDeclaration,
  verifyAggregate,
} from '../src/application/parallel-integration/index.js';
import { RoleHost, RoleHostLauncher } from '../src/application/role-conversations/index.js';
import { disposeRunResources } from '../src/application/run-cleanup/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import {
  OwnedProjectProcess,
  ProjectCommandProcess,
  ProjectEvidenceStore,
} from '../src/application/project-commands/index.js';
import { ReadinessGit } from '../src/application/readiness/index.js';
import {
  RunIdentityStore,
  RunIdentityStorageError,
} from '../src/application/run-identity/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import { ReadinessGitLive } from '../src/platform/readiness.js';
import { goldenConfiguration } from './fixtures/checks-runtime-run.js';

import type { PlannedObjective } from '../src/domain/architect-plan.js';
import type { RunEventDraft } from '../src/domain/run-history.js';

const RUN_ID = 'RUN-INTEGRATION';

const TASK_BRANCH = 'foundry/RUN-INTEGRATION';

const WORKSPACE = '/target/.agent/worktrees/RUN-INTEGRATION';

const BASE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

const OBJECTIVES: ReadonlyArray<PlannedObjective> = [
  {
    id: 'OBJ-001',
    title: 'First part',
    affectedPaths: ['src/first.ts'],
    criterionIds: ['AC-001'],
  },
  {
    id: 'OBJ-002',
    title: 'Second part',
    affectedPaths: ['src/second.ts'],
    criterionIds: ['AC-002'],
  },
];

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-integration-'));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return { runDirectory, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function emit(runDirectory: string, createIfMissing: boolean, draft: RunEventDraft) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing,
    build: () => Effect.succeed(draft),
  });
}

function seedCoding(
  fixture: Fixture,
  objectives: ReadonlyArray<PlannedObjective> = OBJECTIVES,
  baseCommit = BASE_COMMIT,
) {
  return Effect.gen(function* () {
    yield* emit(fixture.runDirectory, true, {
      type: 'run-created',
      payload: { taskId: 'TASK-INTEGRATION' },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'source-frozen',
      payload: {
        repository: {
          repositoryRoot: '/target',
          gitDirectory: '/target/.git',
          remoteUrl: 'https://example.invalid/target.git',
        },
        sourceRemote: 'origin',
        sourceBranch: 'main',
        sourceCommit: baseCommit,
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        expectedHead: baseCommit,
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'guidance-frozen',
      payload: {
        sourceCommit: baseCommit,
        manifestPath: 'guidance-manifest.json',
        aggregateHash: 'f'.repeat(64),
        files: [],
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'worktree-ready',
      payload: {
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        headCommit: baseCommit,
        baseCommit,
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'plan-accepted',
      payload: {
        outcome: 'plan_ready',
        criteria: objectives.map((objective) => ({
          id: objective.criterionIds[0] ?? 'AC-001',
          text: `${objective.title} criterion`,
        })),
        runtimeValidationRequired: false,
        execution: { mode: 'parallel', objectives: [...objectives] },
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'plan-accepted', from: 'planning', to: 'coding', checkpoint: null },
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function settleWorker(
  fixture: Fixture,
  objectiveId: string,
  attempt: number,
  commit: string,
  order: number,
) {
  const sessionId = `session-${objectiveId}-${order}`;
  return Effect.gen(function* () {
    yield* emit(fixture.runDirectory, false, {
      type: 'objective-worker',
      payload: {
        phase: 'created',
        objectiveId,
        sessionId,
        attempt,
        generation: attempt,
        commit: null,
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'objective-worker',
      payload: {
        phase: 'settled',
        objectiveId,
        sessionId,
        attempt,
        generation: attempt,
        commit,
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'objective-worker',
      payload: {
        phase: 'disposed',
        objectiveId,
        sessionId,
        attempt,
        generation: attempt,
        commit,
      },
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function acceptAggregate(fixture: Fixture, aggregateCommit: string, baseCommit = BASE_COMMIT) {
  return Effect.gen(function* () {
    yield* emit(fixture.runDirectory, false, {
      type: 'implementation-accepted',
      payload: {
        taskBranch: TASK_BRANCH,
        baseCommit,
        commit: aggregateCommit,
        changedFiles: ['src/first.ts', 'src/second.ts'],
        noChangeCandidate: false,
      },
    });
    yield* emit(fixture.runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'implementation-ready',
        from: 'coding',
        to: 'verifying',
        checkpoint: null,
      },
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function readHistory(fixture: Fixture) {
  return readVerifiedRunHistory({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

function failingWorkerStore(failingPath: string): Layer.Layer<RunIdentityStore> {
  const unused = (name: string) => Effect.die(new Error(`unexpected RunIdentityStore.${name}`));
  return Layer.succeed(
    RunIdentityStore,
    RunIdentityStore.of({
      statPath: () => unused('statPath'),
      readFileBytes: () => unused('readFileBytes'),
      ensureParentDirectory: () => unused('ensureParentDirectory'),
      createRunDirectoryExclusive: () => unused('createRunDirectoryExclusive'),
      writeFileBytes: () => unused('writeFileBytes'),
      removeDirectory: (path) =>
        path === failingPath
          ? Effect.fail(new RunIdentityStorageError({ message: 'forced worker cleanup failure' }))
          : Effect.void,
    }),
  );
}

const DummyHost = Layer.succeed(
  RoleHost,
  RoleHost.of({
    capabilities: () => Effect.die(new Error('the cleanup test provides no host')),
    create: () => Effect.die(new Error('the cleanup test provides no host')),
    submit: () => Effect.die(new Error('the cleanup test provides no host')),
    observe: () => Effect.die(new Error('the cleanup test provides no host')),
    stop: () => Effect.die(new Error('the cleanup test provides no host')),
  }),
);

const DummyLauncher = Layer.succeed(
  RoleHostLauncher,
  RoleHostLauncher.of({ launch: () => DummyHost }),
);

function unusedRuntimeServices(): Layer.Layer<
  OwnedProjectProcess | ProjectCommandProcess | ProjectEvidenceStore | ReadinessGit
> {
  return Layer.mergeAll(
    Layer.succeed(
      OwnedProjectProcess,
      OwnedProjectProcess.of({
        start: () => Effect.die(new Error('the cleanup test owns no process')),
        terminate: () => Effect.die(new Error('the cleanup test owns no process')),
      }),
    ),
    Layer.succeed(
      ProjectCommandProcess,
      ProjectCommandProcess.of({
        run: () => Effect.die(new Error('the cleanup test runs no command')),
      }),
    ),
    Layer.succeed(
      ProjectEvidenceStore,
      ProjectEvidenceStore.of({
        write: () => Effect.die(new Error('the cleanup test stores no evidence')),
      }),
    ),
    Layer.succeed(
      ReadinessGit,
      ReadinessGit.of({ run: () => Effect.die(new Error('the cleanup test runs no git')) }),
    ),
  );
}

interface GitRepo {
  readonly directory: string;
  readonly base: string;
  readonly first: string;
  readonly second: string;
  readonly cleanup: () => void;
}

function git(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();
}

function setupGitRepo(): GitRepo {
  const directory = mkdtempSync(join(tmpdir(), 'foundry-integration-git-'));
  git(directory, ['init', '-b', 'main']);
  git(directory, ['config', 'user.email', 'integration@example.com']);
  git(directory, ['config', 'user.name', 'Foundry Integration']);
  writeFileSync(join(directory, 'base.txt'), 'base\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '-m', 'base']);
  const base = git(directory, ['rev-parse', 'HEAD']);

  git(directory, ['checkout', '-b', 'worker-first']);
  writeFileSync(join(directory, 'first.txt'), 'first\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '-m', 'first objective']);
  const first = git(directory, ['rev-parse', 'HEAD']);

  git(directory, ['checkout', 'main']);
  git(directory, ['checkout', '-b', 'worker-second']);
  writeFileSync(join(directory, 'second.txt'), 'second\n');
  git(directory, ['add', '.']);
  git(directory, ['commit', '-m', 'second objective']);
  const second = git(directory, ['rev-parse', 'HEAD']);

  git(directory, ['checkout', 'main']);
  return {
    directory,
    base,
    first,
    second,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function mergeBranch(directory: string, branch: string): string {
  git(directory, ['merge', '--no-ff', '--no-edit', branch]);
  return git(directory, ['rev-parse', 'HEAD']);
}

describe('integration declaration', () => {
  it.effect('records the plan order and accepted commits before Lead Coder starts', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedCoding(fixture);
        yield* settleWorker(fixture, 'OBJ-002', 4, 'b'.repeat(40), 1);
        yield* settleWorker(fixture, 'OBJ-001', 1, 'a'.repeat(40), 2);

        const declaration = yield* recordIntegrationDeclaration({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          objectives: OBJECTIVES,
        }).pipe(Effect.provide(Layer.mergeAll(RunIdentityLive, RunHistoryLive)));

        expect(declaration.objectiveIds).toEqual(['OBJ-001', 'OBJ-002']);
        expect(declaration.declaredOrder).toEqual(['OBJ-001', 'OBJ-002']);
        expect(declaration.commits).toEqual(['a'.repeat(40), 'b'.repeat(40)]);

        const history = yield* readHistory(fixture);
        expect(history.derived.integrationDeclared).toEqual(declaration);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses to declare integration until every objective has a verified commit', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedCoding(fixture);
        yield* settleWorker(fixture, 'OBJ-001', 1, 'a'.repeat(40), 1);

        const error = yield* recordIntegrationDeclaration({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          objectives: OBJECTIVES,
        }).pipe(Effect.provide(Layer.mergeAll(RunIdentityLive, RunHistoryLive)), Effect.flip);
        expect(error._tag).toBe('ParallelIntegrationError');

        const history = yield* readHistory(fixture);
        expect(history.derived.integrationDeclared).toBeNull();
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('is idempotent across a resumed declaration', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedCoding(fixture);
        yield* settleWorker(fixture, 'OBJ-001', 1, 'a'.repeat(40), 1);
        yield* settleWorker(fixture, 'OBJ-002', 4, 'b'.repeat(40), 2);
        const layers = Layer.mergeAll(RunIdentityLive, RunHistoryLive);

        yield* recordIntegrationDeclaration({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          objectives: OBJECTIVES,
        }).pipe(Effect.provide(layers));
        yield* recordIntegrationDeclaration({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          objectives: OBJECTIVES,
        }).pipe(Effect.provide(layers));

        const history = yield* readHistory(fixture);
        const declared = history.events.filter((event) => event.type === 'integration-declared');
        expect(declared).toHaveLength(1);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('aggregate verification', () => {
  it.effect('accepts an aggregate that contains every accepted commit in declared order', () =>
    Effect.gen(function* () {
      const repo = setupGitRepo();
      try {
        mergeBranch(repo.directory, 'worker-first');
        const aggregate = mergeBranch(repo.directory, 'worker-second');

        const verification = yield* verifyAggregate({
          runId: RUN_ID,
          workspace: repo.directory,
          baseCommit: repo.base,
          declaration: {
            objectiveIds: ['OBJ-001', 'OBJ-002'],
            commits: [repo.first, repo.second],
            declaredOrder: ['OBJ-001', 'OBJ-002'],
          },
        }).pipe(Effect.provide(ReadinessGitLive));

        expect(verification.aggregateCommit).toBe(aggregate);
        expect(verification.actualOrder).toEqual(['OBJ-001', 'OBJ-002']);
        expect(verification.deviationReason).toBeNull();
      } finally {
        repo.cleanup();
      }
    }),
  );

  it.effect('records a deviation reason when the Git order differs from the declared order', () =>
    Effect.gen(function* () {
      const repo = setupGitRepo();
      try {
        mergeBranch(repo.directory, 'worker-second');
        mergeBranch(repo.directory, 'worker-first');

        const verification = yield* verifyAggregate({
          runId: RUN_ID,
          workspace: repo.directory,
          baseCommit: repo.base,
          declaration: {
            objectiveIds: ['OBJ-001', 'OBJ-002'],
            commits: [repo.first, repo.second],
            declaredOrder: ['OBJ-001', 'OBJ-002'],
          },
        }).pipe(Effect.provide(ReadinessGitLive));

        expect(verification.actualOrder).toEqual(['OBJ-002', 'OBJ-001']);
        expect(verification.deviationReason).toContain('OBJ-002, OBJ-001');
      } finally {
        repo.cleanup();
      }
    }),
  );

  it.effect('rejects an aggregate that does not contain an accepted commit', () =>
    Effect.gen(function* () {
      const repo = setupGitRepo();
      try {
        mergeBranch(repo.directory, 'worker-first');

        const error = yield* verifyAggregate({
          runId: RUN_ID,
          workspace: repo.directory,
          baseCommit: repo.base,
          declaration: {
            objectiveIds: ['OBJ-001', 'OBJ-002'],
            commits: [repo.first, repo.second],
            declaredOrder: ['OBJ-001', 'OBJ-002'],
          },
        }).pipe(Effect.provide(ReadinessGitLive), Effect.flip);

        expect(error._tag).toBe('ParallelIntegrationError');
      } finally {
        repo.cleanup();
      }
    }),
  );

  it.effect('rejects an aggregate that produced no new commit', () =>
    Effect.gen(function* () {
      const repo = setupGitRepo();
      try {
        const error = yield* verifyAggregate({
          runId: RUN_ID,
          workspace: repo.directory,
          baseCommit: repo.base,
          declaration: {
            objectiveIds: ['OBJ-001', 'OBJ-002'],
            commits: [repo.first, repo.second],
            declaredOrder: ['OBJ-001', 'OBJ-002'],
          },
        }).pipe(Effect.provide(ReadinessGitLive), Effect.flip);

        expect(error._tag).toBe('ParallelIntegrationError');
      } finally {
        repo.cleanup();
      }
    }),
  );
});

describe('integration cleanup', () => {
  it.effect('keeps the accepted aggregate and reports a failed worker cleanup', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedCoding(fixture);
        yield* settleWorker(fixture, 'OBJ-001', 1, 'a'.repeat(40), 1);
        yield* settleWorker(fixture, 'OBJ-002', 4, 'b'.repeat(40), 2);
        yield* acceptAggregate(fixture, 'c'.repeat(40));
        const configuration = yield* goldenConfiguration('/target');
        const workerWorkspace = `${WORKSPACE}--worker-OBJ-001-000000000000`;

        const report = yield* disposeRunResources({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          configuration,
          runtime: null,
          workerWorktrees: [{ name: 'OBJ-001', workspace: workerWorkspace }],
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              failingWorkerStore(workerWorkspace),
              RunHistoryLive,
              DummyLauncher,
              unusedRuntimeServices(),
            ),
          ),
        );

        expect(report?.outcome).toBe('failed');
        expect(report?.resources).toContainEqual({
          kind: 'worker-worktree',
          name: 'OBJ-001',
          disposition: 'failed',
        });

        // The accepted aggregate and its state are preserved by a cleanup failure.
        const history = yield* readHistory(fixture);
        expect(history.derived.implementation?.commit).toBe('c'.repeat(40));
        expect(history.derived.state).toBe('verifying');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('integration completion', () => {
  it.effect('binds the aggregate and actual order to the run as the only result head', () =>
    Effect.gen(function* () {
      const repo = setupGitRepo();
      const fixture = setupFixture();
      try {
        yield* seedCoding(fixture, OBJECTIVES, repo.base);
        yield* settleWorker(fixture, 'OBJ-001', 1, repo.first, 1);
        yield* settleWorker(fixture, 'OBJ-002', 4, repo.second, 2);
        const layers = Layer.mergeAll(RunIdentityLive, RunHistoryLive);
        yield* recordIntegrationDeclaration({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          objectives: OBJECTIVES,
        }).pipe(Effect.provide(layers));
        mergeBranch(repo.directory, 'worker-first');
        const aggregate = mergeBranch(repo.directory, 'worker-second');
        yield* acceptAggregate(fixture, aggregate, repo.base);

        const verification = yield* verifyAggregate({
          runId: RUN_ID,
          workspace: repo.directory,
          baseCommit: repo.base,
          declaration: {
            objectiveIds: ['OBJ-001', 'OBJ-002'],
            commits: [repo.first, repo.second],
            declaredOrder: ['OBJ-001', 'OBJ-002'],
          },
        }).pipe(Effect.provide(ReadinessGitLive));

        const completion = yield* recordIntegrationCompleted({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          verification,
        }).pipe(Effect.provide(Layer.mergeAll(RunIdentityLive, RunHistoryLive)));

        expect(completion).toEqual({
          aggregateCommit: aggregate,
          actualOrder: ['OBJ-001', 'OBJ-002'],
          deviationReason: null,
        });

        const history = yield* readHistory(fixture);
        expect(history.derived.integrationCompleted).toEqual(completion);
        expect(history.derived.implementation?.commit).toBe(aggregate);
        expect(history.derived.state).toBe('verifying');
      } finally {
        fixture.cleanup();
        repo.cleanup();
      }
    }),
  );

  it.effect('refuses a completion whose actual order does not cover the declared set', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        yield* seedCoding(fixture);
        yield* settleWorker(fixture, 'OBJ-001', 1, 'a'.repeat(40), 1);
        yield* settleWorker(fixture, 'OBJ-002', 4, 'b'.repeat(40), 2);
        const layers = Layer.mergeAll(RunIdentityLive, RunHistoryLive);
        yield* recordIntegrationDeclaration({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          objectives: OBJECTIVES,
        }).pipe(Effect.provide(layers));
        yield* acceptAggregate(fixture, 'c'.repeat(40));

        const error = yield* recordIntegrationCompleted({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          verification: {
            aggregateCommit: 'c'.repeat(40),
            actualOrder: ['OBJ-001'],
            deviationReason: null,
          },
        }).pipe(Effect.provide(layers), Effect.flip);

        expect(error._tag).toBe('ParallelIntegrationError');
        const history = yield* readHistory(fixture);
        expect(history.derived.integrationCompleted).toBeNull();
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
