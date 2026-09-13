import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitHubPublication } from '../src/application/decision-publication/index.js';
import { reconcilePublication } from '../src/application/decision-publication/recovery.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { decodeProjectConfiguration } from '../src/application/project-configuration.js';
import { ReadinessGit } from '../src/application/readiness/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { goldenConfigurationDocument } from './fixtures/checks-runtime-run.js';

import type { ProjectConfiguration } from '../src/domain/project-configuration.js';
import type { RunEvent, RunEventDraft } from '../src/domain/run-history.js';
import type { PublicationCheckpointStage } from '../src/domain/decision-publication.js';
import type { RunHistoryStorage } from '../src/application/run-history/index.js';
import type {
  GitHubCreatePullRequestOptions,
  GitHubPullRequest,
  GitHubPullRequestLookup,
  GitHubPushTaskBranchOptions,
  GitHubRefreshPullRequestBodyOptions,
} from '../src/application/decision-publication/index.js';
import type { ImplementationObservation } from '../src/application/git-provisioning/index.js';
import type { GitCommandResult } from '../src/application/readiness/index.js';

const RUN_ID = 'RUN-RECOVERY';

const FROZEN_COMMIT = 'a'.repeat(40);

const RESULT_COMMIT = 'b'.repeat(40);

const REMOTE_SOURCE_COMMIT = 'c'.repeat(40);

const TASK_BRANCH = 'foundry/RUN-RECOVERY';

const WORKSPACE = '/target/.agent/worktrees/RUN-RECOVERY';

const REPOSITORY = 'example/target';

const REMOTE_URL = 'git@github.com:example/target.git';

const PUBLICATION_REMOTE = 'origin';

const GOLDEN_AGGREGATE_HASH = 'f'.repeat(64);

const DECISION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const DECISION_NONCE = 'a'.repeat(32);

const DRAFT_URL = `https://github.com/${REPOSITORY}/pull/9`;

const EXISTING_PR_NUMBER = 3;

const EXISTING_PR_URL = `https://github.com/${REPOSITORY}/pull/${EXISTING_PR_NUMBER}`;

const DECISION_OPTIONS = [
  { id: 'OPT-001', label: 'Keep the stricter bound', action: 'accept' as const },
  { id: 'OPT-002', label: 'Relax the bound', action: 'correct' as const },
] as const;

const REVIEWER_QUESTION = 'Should the stricter bound remain in place?';

const REVIEWER_RECOMMENDATION = 'Keep the stricter bound until the follow-up lands.';

type Checkpoint = Extract<RunEvent, { readonly type: 'publication-checkpoint' }>;

type Reconciled = Extract<RunEvent, { readonly type: 'publication-reconciled' }>;

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(label: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), `foundry-recovery-${label}-`));
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
  });
}

function verificationReport() {
  return {
    attempt: 1,
    repository: '/target',
    commit: RESULT_COMMIT,
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

function seedReviewing(runDirectory: string) {
  return Effect.gen(function* () {
    yield* emit(runDirectory, true, {
      type: 'run-created',
      payload: { taskId: 'TASK-RECOVERY' },
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
      payload: {
        outcome: 'plan_ready',
        criteria: [
          { id: 'AC-001', text: 'The stricter bound is implemented.' },
          { id: 'AC-002', text: 'Existing callers keep working.' },
        ],
        runtimeValidationRequired: false,
        execution: {
          mode: 'sequential',
          objectives: [
            {
              id: 'OBJ-001',
              title: 'Implement the accepted plan',
              affectedPaths: ['.'],
              criterionIds: ['AC-001', 'AC-002'],
            },
          ],
        },
      },
    });
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
  }).pipe(Effect.provide(RunHistoryLive));
}

function seedPublishing(runDirectory: string) {
  return Effect.gen(function* () {
    yield* seedReviewing(runDirectory);
    yield* emit(runDirectory, false, {
      type: 'role-session-created',
      payload: {
        role: 'reviewer',
        attempt: 1,
        generation: 1,
        sessionId: 'reviewer-session',
        ownershipToken: 'reviewer-owner',
        sequence: 0,
        runtimeIdentity: {
          adapterVersion: 'test',
          provider: 'test',
          model: 'test',
          toolProfile: 'test',
        },
        workingDirectory: null,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'role-session-observed',
      payload: {
        sessionId: 'reviewer-session',
        generation: 1,
        status: 'settled',
        sequence: 1,
        eventCount: 1,
        narrative: 'A person must choose a bound.',
        control: {
          schemaVersion: 1,
          outcome: 'human_decision_required',
          decision: {
            question: REVIEWER_QUESTION,
            recommendation: REVIEWER_RECOMMENDATION,
            options: DECISION_OPTIONS.map((option) => ({
              label: option.label,
              action: option.action,
            })),
          },
        },
      },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'human-decision-required',
        from: 'reviewing',
        to: 'publishing',
        checkpoint: null,
      },
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function seedOpenedDecision(runDirectory: string) {
  return emit(runDirectory, false, {
    type: 'decision-opened',
    payload: {
      decisionId: DECISION_ID,
      nonce: DECISION_NONCE,
      question: REVIEWER_QUESTION,
      recommendation: REVIEWER_RECOMMENDATION,
      options: [...DECISION_OPTIONS],
      resultCommit: RESULT_COMMIT,
    },
  });
}

function seedCheckpoints(runDirectory: string, stages: ReadonlyArray<PublicationCheckpointStage>) {
  return Effect.gen(function* () {
    for (const stage of stages) {
      yield* emit(runDirectory, false, {
        type: 'publication-checkpoint',
        payload: {
          stage,
          draftPrUrl: stage === 'url-recorded' ? DRAFT_URL : null,
          decisionId: DECISION_ID,
          detail: `seeded ${stage}`,
        },
      });
    }
  });
}

function seedPublishFailed(
  runDirectory: string,
  stages: ReadonlyArray<PublicationCheckpointStage>,
) {
  return Effect.gen(function* () {
    yield* seedPublishing(runDirectory);
    yield* seedOpenedDecision(runDirectory);
    yield* seedCheckpoints(runDirectory, stages);
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'publication-unresolved',
        from: 'publishing',
        to: 'publish_failed',
        checkpoint: 'publishing',
      },
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

function seedHumanDecisionRequired(runDirectory: string) {
  return Effect.gen(function* () {
    yield* seedPublishing(runDirectory);
    yield* seedOpenedDecision(runDirectory);
    yield* seedCheckpoints(runDirectory, ['url-recorded']);
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'draft-pr-reconciled',
        from: 'publishing',
        to: 'human_decision_required',
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
  lookupExactPullRequest: number;
  readonly create: Array<GitHubCreatePullRequestOptions>;
  readonly refresh: Array<GitHubRefreshPullRequestBodyOptions>;
  readonly push: Array<GitHubPushTaskBranchOptions>;
}

interface GitHubHarness {
  readonly layer: Layer.Layer<GitHubPublication>;
  readonly calls: GitHubCalls;
}

function createdPullRequest(options: GitHubCreatePullRequestOptions): GitHubPullRequest {
  return {
    number: 7,
    url: `https://github.com/${options.repository}/pull/7`,
    draft: true,
    headBranch: options.headBranch,
    headCommit: RESULT_COMMIT,
    baseBranch: options.baseBranch,
  };
}

function existingPullRequest(number = EXISTING_PR_NUMBER): GitHubPullRequest {
  return {
    number,
    url: `https://github.com/${REPOSITORY}/pull/${number}`,
    draft: true,
    headBranch: TASK_BRANCH,
    headCommit: RESULT_COMMIT,
    baseBranch: 'main',
  };
}

function githubHarness(lookup: GitHubPullRequestLookup = { kind: 'absent' }): GitHubHarness {
  const calls: GitHubCalls = {
    lookupRepositoryIdentity: 0,
    lookupExactPullRequest: 0,
    create: [],
    refresh: [],
    push: [],
  };
  const layer = Layer.succeed(
    GitHubPublication,
    GitHubPublication.of({
      lookupRepositoryIdentity: (options) => {
        calls.lookupRepositoryIdentity += 1;
        return Effect.succeed({ repository: options.repository });
      },
      lookupExactPullRequest: () => {
        calls.lookupExactPullRequest += 1;
        return Effect.succeed(lookup);
      },
      createDraftPullRequest: (options) => {
        calls.create.push(options);
        return Effect.succeed(createdPullRequest(options));
      },
      refreshOwnedDraftPullRequestBody: (options) => {
        calls.refresh.push(options);
        return Effect.succeed({
          number: options.pullRequestNumber,
          url: `https://github.com/${REPOSITORY}/pull/${options.pullRequestNumber}`,
          draft: true,
          headBranch: TASK_BRANCH,
          headCommit: RESULT_COMMIT,
          baseBranch: 'main',
        });
      },
      pushTaskBranch: (options) => {
        calls.push.push(options);
        return Effect.void;
      },
    }),
  );
  return { layer, calls };
}

const defaultImplementation: ImplementationObservation = {
  workspaceExists: true,
  currentBranch: TASK_BRANCH,
  headCommit: RESULT_COMMIT,
  clean: true,
  baseIsAncestor: true,
  changedFiles: ['src/implementation.ts'],
};

interface RunGitHarness {
  readonly layer: Layer.Layer<RunGit>;
  readonly calls: { createBranch: number };
}

function runGitHarness(
  observation: ImplementationObservation = defaultImplementation,
): RunGitHarness {
  const calls = { createBranch: 0 };
  const unused = (name: string) =>
    Effect.die(new Error(`decision publication recovery must not call RunGit.${name}`));
  const layer = Layer.succeed(
    RunGit,
    RunGit.of({
      inspectRepository: () =>
        Effect.succeed({
          repositoryRoot: '/target',
          gitDirectory: '/target/.git',
          remoteUrl: REMOTE_URL,
        }),
      fetchSource: () => Effect.succeed({ commit: REMOTE_SOURCE_COMMIT }),
      commitExists: () => unused('commitExists'),
      readBranch: () => unused('readBranch'),
      createBranch: () => {
        calls.createBranch += 1;
        return unused('createBranch');
      },
      readWorktree: () => unused('readWorktree'),
      createWorktree: () => unused('createWorktree'),
      observeImplementation: () => Effect.succeed(observation),
    }),
  );
  return { layer, calls };
}

function readinessGitHarness(mergeBaseExitCode: number): Layer.Layer<ReadinessGit> {
  return Layer.succeed(
    ReadinessGit,
    ReadinessGit.of({
      run: (args: ReadonlyArray<string>): Effect.Effect<GitCommandResult, never> =>
        Effect.succeed({
          stdout: '',
          exitCode: args[0] === 'merge-base' ? mergeBaseExitCode : 0,
        }),
    }),
  );
}

interface RecoveryHarness {
  readonly github: GitHubHarness;
  readonly git: RunGitHarness;
  readonly layers: Layer.Layer<GitHubPublication | RunGit | ReadinessGit | RunHistoryStorage>;
}

function recoveryHarness(
  options: {
    readonly lookup?: GitHubPullRequestLookup;
    readonly observation?: ImplementationObservation;
    readonly mergeBaseExitCode?: number;
  } = {},
): RecoveryHarness {
  const github = githubHarness(options.lookup ?? { kind: 'absent' });
  const git = runGitHarness(options.observation ?? defaultImplementation);
  const layers = Layer.mergeAll(
    RunHistoryLive,
    github.layer,
    git.layer,
    readinessGitHarness(options.mergeBaseExitCode ?? 0),
  );
  return { github, git, layers };
}

function runReconcile(
  fixture: Fixture,
  configuration: ProjectConfiguration,
  harness: RecoveryHarness,
) {
  return reconcilePublication({
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
    .filter((event): event is Checkpoint => event.type === 'publication-checkpoint')
    .map((event) => event.payload);
}

function reconciledOf(events: ReadonlyArray<RunEvent>): Reconciled['payload'] | null {
  const found = events.find(
    (event): event is Reconciled => event.type === 'publication-reconciled',
  );
  return found === undefined ? null : found.payload;
}

describe('decision publication recovery', () => {
  it.effect('finishes a pushed but unpublished run by creating the one draft PR', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('push-only');
      try {
        yield* seedPublishFailed(fixture.runDirectory, ['pre-push', 'pushed']);
        const configuration = yield* publicationConfiguration();
        const harness = recoveryHarness();
        const report = yield* runReconcile(fixture, configuration, harness);

        expect(report).toEqual({
          outcome: 'reconciled',
          draftPrUrl: `https://github.com/${REPOSITORY}/pull/7`,
        });
        expect(harness.github.calls.push).toHaveLength(0);
        expect(harness.github.calls.create).toHaveLength(1);
        expect(harness.github.calls.refresh).toHaveLength(0);
        expect(harness.git.calls.createBranch).toBe(0);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('human_decision_required');
        expect(checkpointsOf(after.events).map((checkpoint) => checkpoint.stage)).toEqual([
          'pre-push',
          'pushed',
          'pull-request-located',
          'pull-request-created',
          'url-recorded',
        ]);
        expect(reconciledOf(after.events)?.agreement).toBe('push');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('locates the exact pair and records the URL without opening a duplicate', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('pr-created');
      try {
        yield* seedPublishFailed(fixture.runDirectory, [
          'pre-push',
          'pushed',
          'pull-request-located',
          'pull-request-created',
        ]);
        const configuration = yield* publicationConfiguration();
        const harness = recoveryHarness({
          lookup: { kind: 'exact', pullRequest: existingPullRequest() },
        });
        const report = yield* runReconcile(fixture, configuration, harness);

        expect(report).toEqual({ outcome: 'reconciled', draftPrUrl: EXISTING_PR_URL });
        expect(harness.github.calls.create).toHaveLength(0);
        expect(harness.github.calls.refresh).toHaveLength(1);
        expect(harness.github.calls.push).toHaveLength(0);
        expect(harness.git.calls.createBranch).toBe(0);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('human_decision_required');
        expect(checkpointsOf(after.events).map((checkpoint) => checkpoint.stage)).toEqual([
          'pre-push',
          'pushed',
          'pull-request-located',
          'pull-request-created',
          'url-recorded',
        ]);
        expect(reconciledOf(after.events)?.agreement).toBe('pull-request');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('re-pushes an unrecorded push and never creates a new branch', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('no-checkpoint');
      try {
        yield* seedPublishFailed(fixture.runDirectory, []);
        const configuration = yield* publicationConfiguration();
        const harness = recoveryHarness();
        const report = yield* runReconcile(fixture, configuration, harness);

        expect(report).toEqual({
          outcome: 'reconciled',
          draftPrUrl: `https://github.com/${REPOSITORY}/pull/7`,
        });
        expect(harness.github.calls.push).toHaveLength(1);
        expect(harness.github.calls.push[0]?.commit).toBe(RESULT_COMMIT);
        expect(harness.github.calls.create).toHaveLength(1);
        expect(harness.git.calls.createBranch).toBe(0);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('human_decision_required');
        expect(reconciledOf(after.events)?.agreement).toBe('push');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('leaves an irreconcilable ambiguity in publish_failed with its evidence', () =>
    Effect.gen(function* () {
      const ambiguities: ReadonlyArray<GitHubPullRequestLookup> = [
        {
          kind: 'ambiguous',
          detail: 'open non-draft pull request #4 matches the task branch',
        },
        { kind: 'ambiguous', detail: '2 open draft pull requests match the task branch' },
        {
          kind: 'ambiguous',
          detail: 'open draft pull request #5 points at another commit',
        },
      ];
      for (const lookup of ambiguities) {
        const fixture = setupFixture('ambiguous');
        try {
          yield* seedPublishFailed(fixture.runDirectory, ['pre-push', 'pushed']);
          const configuration = yield* publicationConfiguration();
          const harness = recoveryHarness({ lookup });
          const report = yield* runReconcile(fixture, configuration, harness);

          expect(report.outcome, JSON.stringify(lookup)).toBe('still-uncertain');
          expect(harness.github.calls.create).toHaveLength(0);
          expect(harness.github.calls.refresh).toHaveLength(0);
          expect(harness.git.calls.createBranch).toBe(0);

          const after = yield* history(fixture.runDirectory);
          expect(after.derived.state, JSON.stringify(lookup)).toBe('publish_failed');
          expect(checkpointsOf(after.events).map((checkpoint) => checkpoint.stage)).toEqual([
            'pre-push',
            'pushed',
          ]);
          expect(reconciledOf(after.events)).toBeNull();
        } finally {
          fixture.cleanup();
        }
      }
    }),
  );

  it.effect('records draft-url agreement when the exact URL was already durable', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('draft-url');
      try {
        yield* seedPublishFailed(fixture.runDirectory, [
          'pre-push',
          'pushed',
          'pull-request-located',
          'pull-request-created',
          'url-recorded',
        ]);
        const configuration = yield* publicationConfiguration();
        const harness = recoveryHarness({
          lookup: { kind: 'exact', pullRequest: existingPullRequest(9) },
        });
        const report = yield* runReconcile(fixture, configuration, harness);

        expect(report).toEqual({ outcome: 'reconciled', draftPrUrl: DRAFT_URL });
        expect(harness.github.calls.create).toHaveLength(0);
        expect(harness.git.calls.createBranch).toBe(0);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('human_decision_required');
        expect(reconciledOf(after.events)?.agreement).toBe('draft-url');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('reports a durable published run as still waiting for a decision', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('waiting');
      try {
        yield* seedHumanDecisionRequired(fixture.runDirectory);
        const configuration = yield* publicationConfiguration();
        const harness = recoveryHarness();
        const report = yield* runReconcile(fixture, configuration, harness);

        expect(report).toEqual({ outcome: 'waiting' });
        expect(harness.github.calls.lookupRepositoryIdentity).toBe(0);
        expect(harness.github.calls.lookupExactPullRequest).toBe(0);
        expect(harness.github.calls.create).toHaveLength(0);
        expect(harness.github.calls.push).toHaveLength(0);
        expect(harness.git.calls.createBranch).toBe(0);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('human_decision_required');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses to reconcile a run that is not publish_failed', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('not-failed');
      try {
        yield* seedPublishing(fixture.runDirectory);
        const configuration = yield* publicationConfiguration();
        const harness = recoveryHarness();
        const report = yield* runReconcile(fixture, configuration, harness);

        expect(report.outcome).toBe('still-uncertain');
        expect(harness.github.calls.lookupRepositoryIdentity).toBe(0);
        expect(harness.github.calls.push).toHaveLength(0);
        expect(harness.git.calls.createBranch).toBe(0);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('publishing');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses to reconcile a dirty task branch without remote side effects', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('dirty');
      try {
        yield* seedPublishFailed(fixture.runDirectory, ['pre-push', 'pushed']);
        const configuration = yield* publicationConfiguration();
        const harness = recoveryHarness({
          observation: { ...defaultImplementation, clean: false },
        });
        const report = yield* runReconcile(fixture, configuration, harness);

        expect(report.outcome).toBe('still-uncertain');
        expect(harness.github.calls.push).toHaveLength(0);
        expect(harness.github.calls.create).toHaveLength(0);
        expect(harness.git.calls.createBranch).toBe(0);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('publish_failed');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
