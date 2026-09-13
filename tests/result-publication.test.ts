import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitHubPublication } from '../src/application/decision-publication/index.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { decodeProjectConfiguration } from '../src/application/project-configuration.js';
import { PublicationProbe, ReadinessGit } from '../src/application/readiness/index.js';
import {
  publishResultPr,
  renderResultPullRequestBody,
} from '../src/application/result-publication/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { goldenConfigurationDocument } from './fixtures/checks-runtime-run.js';

import type { ProjectConfiguration } from '../src/domain/project-configuration.js';
import type { RunEvent, RunEventDraft } from '../src/domain/run-history.js';
import type { RunHistoryStorage } from '../src/application/run-history/index.js';
import type {
  GitHubCreatePullRequestOptions,
  GitHubPullRequest,
  GitHubPushTaskBranchOptions,
} from '../src/application/decision-publication/index.js';
import type { BranchObservation } from '../src/application/git-provisioning/index.js';
import type { GitCommandResult } from '../src/application/readiness/index.js';

const RUN_ID = 'RUN-RESULT';

const FROZEN_COMMIT = 'a'.repeat(40);

const RESULT_COMMIT = 'b'.repeat(40);

const REMOTE_SOURCE_COMMIT = 'c'.repeat(40);

const TASK_BRANCH = 'foundry/RUN-RESULT';

const WORKSPACE = '/target/.agent/worktrees/RUN-RESULT';

const REPOSITORY = 'example/target';

const REMOTE_URL = 'git@github.com:example/target.git';

const PUBLICATION_REMOTE = 'origin';

const GOLDEN_AGGREGATE_HASH = 'f'.repeat(64);

type Checkpoint = Extract<RunEvent, { readonly type: 'result-pr-checkpoint' }>;

type Recorded = Extract<RunEvent, { readonly type: 'result-pr-recorded' }>;

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(label: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), `foundry-result-${label}-`));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return {
    runDirectory,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function emit(runDirectory: string, createIfMissing: boolean, draft: RunEventDraft) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing,
    build: () => Effect.succeed(draft),
  }).pipe(Effect.provide(RunHistoryLive));
}

function verificationReport(commit: string = RESULT_COMMIT) {
  return {
    attempt: 1,
    repository: '/target',
    commit,
    profileHash: 'd'.repeat(64),
    commandMs: 1000,
    executions: [
      {
        kind: 'gate' as const,
        name: 'formatCheck',
        executable: 'fmt',
        arguments: ['--check'],
        expectedExitCode: 0,
        actualExitCode: 0,
        timedOut: false,
        durationMs: 1,
        log: {
          path: '/evidence/formatCheck.log',
          sha256: 'e'.repeat(64),
          byteLength: 0,
          retainedByteLength: 0,
          truncated: false,
          redactionCount: 0,
        },
        trackedMutation: null,
        reconstructed: false,
        reconstructionError: null,
      },
    ],
    result: 'passed' as const,
  };
}

const ACCEPTED_PLAN = {
  outcome: 'plan_ready' as const,
  criteria: [
    { id: 'AC-001', text: 'The change is implemented.' },
    { id: 'AC-002', text: 'Existing callers keep working.' },
  ],
  runtimeValidationRequired: false,
  execution: {
    mode: 'sequential' as const,
    objectives: [
      {
        id: 'OBJ-001',
        title: 'Implement the accepted plan',
        affectedPaths: ['.'],
        criterionIds: ['AC-001', 'AC-002'],
      },
    ],
  },
};

function seedCompletedChange(runDirectory: string) {
  return Effect.gen(function* () {
    yield* emit(runDirectory, true, {
      type: 'run-created',
      payload: { taskId: 'TASK-RESULT' },
    });
    yield* emit(runDirectory, false, {
      type: 'source-frozen',
      payload: {
        repository: {
          repositoryRoot: '/target',
          gitDirectory: '/target/.git',
          remoteUrl: REMOTE_URL,
        },
        sourceRemote: PUBLICATION_REMOTE,
        sourceBranch: 'main',
        sourceCommit: FROZEN_COMMIT,
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        expectedHead: FROZEN_COMMIT,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'guidance-frozen',
      payload: {
        sourceCommit: FROZEN_COMMIT,
        manifestPath: 'guidance-manifest.json',
        aggregateHash: GOLDEN_AGGREGATE_HASH,
        files: [],
      },
    });
    yield* emit(runDirectory, false, {
      type: 'worktree-ready',
      payload: {
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        headCommit: FROZEN_COMMIT,
        baseCommit: FROZEN_COMMIT,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
    });
    yield* emit(runDirectory, false, { type: 'plan-accepted', payload: ACCEPTED_PLAN });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'plan-accepted', from: 'planning', to: 'coding', checkpoint: null },
    });
    yield* emit(runDirectory, false, {
      type: 'implementation-accepted',
      payload: {
        taskBranch: TASK_BRANCH,
        baseCommit: FROZEN_COMMIT,
        commit: RESULT_COMMIT,
        changedFiles: ['src/implementation.ts'],
        noChangeCandidate: false,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'implementation-ready',
        from: 'coding',
        to: 'verifying',
        checkpoint: null,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'verification-completed',
      payload: verificationReport(),
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'checks-passed-reviewing',
        from: 'verifying',
        to: 'reviewing',
        checkpoint: null,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'review-approved',
        from: 'reviewing',
        to: 'completed',
        checkpoint: null,
      },
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function seedCompletedNoChange(runDirectory: string) {
  return Effect.gen(function* () {
    yield* emit(runDirectory, true, {
      type: 'run-created',
      payload: { taskId: 'TASK-RESULT' },
    });
    yield* emit(runDirectory, false, {
      type: 'source-frozen',
      payload: {
        repository: {
          repositoryRoot: '/target',
          gitDirectory: '/target/.git',
          remoteUrl: REMOTE_URL,
        },
        sourceRemote: PUBLICATION_REMOTE,
        sourceBranch: 'main',
        sourceCommit: FROZEN_COMMIT,
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        expectedHead: FROZEN_COMMIT,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'guidance-frozen',
      payload: {
        sourceCommit: FROZEN_COMMIT,
        manifestPath: 'guidance-manifest.json',
        aggregateHash: GOLDEN_AGGREGATE_HASH,
        files: [],
      },
    });
    yield* emit(runDirectory, false, {
      type: 'worktree-ready',
      payload: {
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        headCommit: FROZEN_COMMIT,
        baseCommit: FROZEN_COMMIT,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
    });
    yield* emit(runDirectory, false, {
      type: 'plan-accepted',
      payload: { ...ACCEPTED_PLAN, outcome: 'no_change_candidate' },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'plan-no-change', from: 'planning', to: 'verifying', checkpoint: null },
    });
    yield* emit(runDirectory, false, {
      type: 'implementation-accepted',
      payload: {
        taskBranch: TASK_BRANCH,
        baseCommit: FROZEN_COMMIT,
        commit: null,
        changedFiles: [],
        noChangeCandidate: true,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'verification-completed',
      payload: verificationReport(FROZEN_COMMIT),
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'checks-passed-reviewing',
        from: 'verifying',
        to: 'reviewing',
        checkpoint: null,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'review-approved-no-change',
        from: 'reviewing',
        to: 'completed_no_change',
        checkpoint: null,
      },
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function publicationConfiguration(configured = true): Effect.Effect<ProjectConfiguration, unknown> {
  const document = {
    ...goldenConfigurationDocument('/target', false),
    decisionPublication: configured
      ? { remote: PUBLICATION_REMOTE, draft: true, maintainersCanModify: false }
      : null,
  };
  return decodeProjectConfiguration(document, '/target');
}

interface GitHubCalls {
  lookupRepositoryIdentity: number;
  readonly open: Array<GitHubCreatePullRequestOptions>;
  readonly push: Array<GitHubPushTaskBranchOptions>;
}

interface GitHubHarness {
  readonly layer: Layer.Layer<GitHubPublication>;
  readonly calls: GitHubCalls;
}

function resultPullRequest(
  options: GitHubCreatePullRequestOptions,
  number = 11,
): GitHubPullRequest {
  return {
    number,
    url: `https://github.com/${REPOSITORY}/pull/${number}`,
    draft: false,
    headBranch: options.headBranch,
    headCommit: RESULT_COMMIT,
    baseBranch: options.baseBranch,
  };
}

function githubHarness(): GitHubHarness {
  const calls: GitHubCalls = {
    lookupRepositoryIdentity: 0,
    open: [],
    push: [],
  };
  const layer = Layer.succeed(
    GitHubPublication,
    GitHubPublication.of({
      lookupRepositoryIdentity: (options) => {
        calls.lookupRepositoryIdentity += 1;
        return Effect.succeed({ repository: options.repository });
      },
      lookupExactPullRequest: () =>
        Effect.die(new Error('result publication must not look up a draft PR')),
      createDraftPullRequest: () =>
        Effect.die(new Error('result publication must not create a draft PR')),
      openResultPullRequest: (options) => {
        calls.open.push(options);
        return Effect.succeed(resultPullRequest(options));
      },
      refreshOwnedDraftPullRequestBody: () =>
        Effect.die(new Error('result publication must not refresh a draft PR')),
      pushTaskBranch: (options) => {
        calls.push.push(options);
        return Effect.void;
      },
      listIssueCommentsAfter: () => Effect.succeed({ comments: [], truncated: false }),
      collaboratorPermission: () => Effect.succeed({ permission: 'maintain' }),
    }),
  );
  return { layer, calls };
}

function runGitHarness(branch: BranchObservation = { exists: true, commit: RESULT_COMMIT }) {
  return Layer.succeed(
    RunGit,
    RunGit.of({
      inspectRepository: () =>
        Effect.succeed({
          repositoryRoot: '/target',
          gitDirectory: '/target/.git',
          remoteUrl: REMOTE_URL,
        }),
      fetchSource: () => Effect.succeed({ commit: REMOTE_SOURCE_COMMIT }),
      commitExists: () => Effect.succeed(true),
      readBranch: () => Effect.succeed(branch),
      createBranch: () => Effect.die(new Error('result publication must not create a branch')),
      readWorktree: () => Effect.die(new Error('result publication must not read a worktree')),
      createWorktree: () => Effect.die(new Error('result publication must not create a worktree')),
      observeImplementation: () =>
        Effect.die(new Error('result publication must not observe the worktree')),
    }),
  );
}

function readinessGitHarness(mergeBaseExitCode = 0): Layer.Layer<ReadinessGit> {
  return Layer.succeed(
    ReadinessGit,
    ReadinessGit.of({
      run: (args: ReadonlyArray<string>): Effect.Effect<GitCommandResult, never> =>
        args[0] === 'remote' && args[1] === 'get-url'
          ? Effect.succeed({ stdout: `${REMOTE_URL}\n`, exitCode: 0 })
          : Effect.succeed({
              stdout: '',
              exitCode: args[0] === 'merge-base' ? mergeBaseExitCode : 0,
            }),
    }),
  );
}

const publicationProbe = Layer.succeed(
  PublicationProbe,
  PublicationProbe.of({
    observe: (request) =>
      Effect.succeed({
        repository: request.repository,
        tokenPresent: true,
        push: true,
        collaboratorPermission: 'admin' as const,
        issueCommentReadable: true,
        tokenScopes: null,
        protectedBranches: ['main'],
        limitations: [],
      }),
  }),
);

interface PublishHarness {
  readonly github: GitHubHarness;
  readonly layers: Layer.Layer<
    GitHubPublication | RunGit | ReadinessGit | PublicationProbe | RunHistoryStorage
  >;
}

function publishHarness(
  options: {
    readonly branch?: BranchObservation;
    readonly mergeBaseExitCode?: number;
  } = {},
): PublishHarness {
  const github = githubHarness();
  const layers = Layer.mergeAll(
    RunHistoryLive,
    github.layer,
    runGitHarness(options.branch ?? { exists: true, commit: RESULT_COMMIT }),
    readinessGitHarness(options.mergeBaseExitCode ?? 0),
    publicationProbe,
  );
  return { github, layers };
}

function runPublish(
  fixture: Fixture,
  configuration: ProjectConfiguration,
  harness: PublishHarness,
) {
  return publishResultPr({
    runDirectory: fixture.runDirectory,
    runId: RUN_ID,
    configuration,
  }).pipe(Effect.provide(harness.layers));
}

function history(runDirectory: string) {
  return readVerifiedRunHistory({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

function checkpointsOf(events: ReadonlyArray<RunEvent>): ReadonlyArray<Checkpoint['payload']> {
  return events
    .filter((event): event is Checkpoint => event.type === 'result-pr-checkpoint')
    .map((event) => event.payload);
}

function recordedOf(events: ReadonlyArray<RunEvent>): Recorded['payload'] | null {
  const found = events.find((event): event is Recorded => event.type === 'result-pr-recorded');
  return found === undefined ? null : found.payload;
}

describe('result publication on approval', () => {
  it.effect('publishes one ordinary result PR and records the settled URL', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('publish');
      try {
        yield* seedCompletedChange(fixture.runDirectory);
        const configuration = yield* publicationConfiguration();
        const harness = publishHarness();
        const report = yield* runPublish(fixture, configuration, harness);

        expect(report).toEqual({
          outcome: 'published',
          url: `https://github.com/${REPOSITORY}/pull/11`,
        });
        expect(harness.github.calls.push).toHaveLength(1);
        expect(harness.github.calls.push[0]?.repositoryPath).toBe('/target');
        expect(harness.github.calls.push[0]?.commit).toBe(RESULT_COMMIT);
        expect(harness.github.calls.open).toHaveLength(1);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('completed');
        const recorded = recordedOf(after.events);
        expect(recorded).toEqual({
          url: `https://github.com/${REPOSITORY}/pull/11`,
          commit: RESULT_COMMIT,
          taskBranch: TASK_BRANCH,
        });
        expect(checkpointsOf(after.events).map((checkpoint) => checkpoint.stage)).toEqual([
          'pre-push',
          'pushed',
          'pull-request-created',
          'url-recorded',
        ]);
        for (const checkpoint of checkpointsOf(after.events)) {
          if (checkpoint.stage === 'url-recorded') {
            expect(checkpoint.url).toBe(recorded?.url);
          } else {
            expect(checkpoint.url).toBeNull();
          }
          expect(checkpoint.commit).toBe(RESULT_COMMIT);
        }

        const body = harness.github.calls.open[0]?.body ?? '';
        expect(harness.github.calls.open[0]?.title).toContain(RUN_ID);
        expect(body).toContain('Approved result');
        expect(body).toContain(RESULT_COMMIT);
        expect(body).toContain('AC-001');
        expect(body).not.toMatch(/\/foundry decide/u);
        expect(body).not.toMatch(/merge-ready/iu);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('re-running publication is idempotent and never opens a duplicate PR', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('idempotent');
      try {
        yield* seedCompletedChange(fixture.runDirectory);
        const configuration = yield* publicationConfiguration();
        const harness = publishHarness();
        const first = yield* runPublish(fixture, configuration, harness);
        const second = yield* runPublish(fixture, configuration, harness);

        expect(first).toEqual(second);
        expect(harness.github.calls.push).toHaveLength(1);
        expect(harness.github.calls.open).toHaveLength(1);

        const after = yield* history(fixture.runDirectory);
        expect(recordedOf(after.events)?.url).toBe(`https://github.com/${REPOSITORY}/pull/11`);
        expect(after.events.filter((event) => event.type === 'result-pr-recorded')).toHaveLength(1);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('reconciles a partial result publication without a second push or PR', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('reconcile');
      try {
        yield* seedCompletedChange(fixture.runDirectory);
        yield* emit(fixture.runDirectory, false, {
          type: 'result-pr-checkpoint',
          payload: {
            stage: 'pre-push',
            url: null,
            commit: RESULT_COMMIT,
            detail: 'verified before an interrupted push',
          },
        });
        yield* emit(fixture.runDirectory, false, {
          type: 'result-pr-checkpoint',
          payload: {
            stage: 'pushed',
            url: null,
            commit: RESULT_COMMIT,
            detail: 'interrupted before the pull request existed',
          },
        });
        const configuration = yield* publicationConfiguration();
        const harness = publishHarness();
        const report = yield* runPublish(fixture, configuration, harness);

        expect(report).toEqual({
          outcome: 'published',
          url: `https://github.com/${REPOSITORY}/pull/11`,
        });
        expect(harness.github.calls.push).toHaveLength(0);
        expect(harness.github.calls.open).toHaveLength(1);

        const after = yield* history(fixture.runDirectory);
        expect(checkpointsOf(after.events).map((checkpoint) => checkpoint.stage)).toEqual([
          'pre-push',
          'pushed',
          'pull-request-created',
          'url-recorded',
        ]);
        expect(recordedOf(after.events)?.url).toBe(`https://github.com/${REPOSITORY}/pull/11`);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('skips publication without remote side effects when it is not configured', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('unconfigured');
      try {
        yield* seedCompletedChange(fixture.runDirectory);
        const configuration = yield* publicationConfiguration(false);
        const harness = publishHarness();
        const report = yield* runPublish(fixture, configuration, harness);

        expect(report.outcome).toBe('skipped');
        if (report.outcome === 'skipped') {
          expect(report.reason).toContain('not configured');
        }
        expect(harness.github.calls.lookupRepositoryIdentity).toBe(0);
        expect(harness.github.calls.open).toHaveLength(0);
        expect(harness.github.calls.push).toHaveLength(0);

        const after = yield* history(fixture.runDirectory);
        expect(recordedOf(after.events)).toBeNull();
        expect(checkpointsOf(after.events)).toHaveLength(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('never publishes a completed no-change run', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('no-change');
      try {
        yield* seedCompletedNoChange(fixture.runDirectory);
        const configuration = yield* publicationConfiguration();
        const harness = publishHarness();
        const report = yield* runPublish(fixture, configuration, harness);

        expect(report.outcome).toBe('skipped');
        if (report.outcome === 'skipped') {
          expect(report.reason).toContain('no changed result');
        }
        expect(harness.github.calls.open).toHaveLength(0);
        expect(harness.github.calls.push).toHaveLength(0);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('completed_no_change');
        expect(recordedOf(after.events)).toBeNull();
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('reports uncertainty without side effects when the branch is not at the result', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('drift');
      try {
        yield* seedCompletedChange(fixture.runDirectory);
        const configuration = yield* publicationConfiguration();
        const harness = publishHarness({ branch: { exists: true, commit: REMOTE_SOURCE_COMMIT } });
        const report = yield* runPublish(fixture, configuration, harness);

        expect(report.outcome).toBe('uncertain');
        expect(harness.github.calls.open).toHaveLength(0);
        expect(harness.github.calls.push).toHaveLength(0);

        const after = yield* history(fixture.runDirectory);
        expect(recordedOf(after.events)).toBeNull();
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('reports uncertainty when the frozen source is no longer contained remotely', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('rewritten');
      try {
        yield* seedCompletedChange(fixture.runDirectory);
        const configuration = yield* publicationConfiguration();
        const harness = publishHarness({ mergeBaseExitCode: 1 });
        const report = yield* runPublish(fixture, configuration, harness);

        expect(report.outcome).toBe('uncertain');
        expect(harness.github.calls.open).toHaveLength(0);
        expect(harness.github.calls.push).toHaveLength(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('result pull request body', () => {
  it('presents the approved result and never a decision channel', () => {
    const body = renderResultPullRequestBody({
      runId: RUN_ID,
      sourceCommit: FROZEN_COMMIT,
      resultCommit: RESULT_COMMIT,
      taskBranch: TASK_BRANCH,
      criteria: [
        { id: 'AC-001', text: 'The change is implemented.' },
        { id: 'AC-002', text: 'Existing callers keep working.' },
      ],
    });
    expect(body).toContain('Approved result');
    expect(body).toContain(TASK_BRANCH);
    expect(body).toContain(FROZEN_COMMIT);
    expect(body).toContain(RESULT_COMMIT);
    expect(body).toContain('AC-001');
    expect(body).not.toMatch(/\/foundry decide/u);
    expect(body).not.toMatch(/draft/iu);
    expect(body).not.toMatch(/merge-ready/iu);
  });
});
