import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import type { Schema } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GitHubPublication,
  publishDecisionDraftPr,
} from '../src/application/decision-publication/index.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { decodeProjectConfiguration } from '../src/application/project-configuration.js';
import { ReadinessGit } from '../src/application/readiness/index.js';
import { handleReviewerTurn } from '../src/application/reviewer-outcomes/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { goldenConfigurationDocument } from './fixtures/checks-runtime-run.js';

import type { ProjectConfiguration } from '../src/domain/project-configuration.js';
import type { RunEvent, RunEventDraft } from '../src/domain/run-history.js';
import type { RunHistoryStorage } from '../src/application/run-history/index.js';
import type { ReviewerEvidenceAssessment } from '../src/application/reviewer-outcomes/index.js';
import type {
  GitHubCreatePullRequestOptions,
  GitHubPullRequest,
  GitHubPullRequestLookup,
  GitHubPushTaskBranchOptions,
  GitHubRefreshPullRequestBodyOptions,
} from '../src/application/decision-publication/index.js';
import type { ImplementationObservation } from '../src/application/git-provisioning/index.js';
import type { GitCommandResult } from '../src/application/readiness/index.js';

const RUN_ID = 'RUN-DECISION';

const FROZEN_COMMIT = 'a'.repeat(40);

const RESULT_COMMIT = 'b'.repeat(40);

const REMOTE_SOURCE_COMMIT = 'c'.repeat(40);

const TASK_BRANCH = 'foundry/RUN-DECISION';

const WORKSPACE = '/target/.agent/worktrees/RUN-DECISION';

const REPOSITORY = 'example/target';

const REMOTE_URL = 'git@github.com:example/target.git';

const PUBLICATION_REMOTE = 'origin';

const GOLDEN_AGGREGATE_HASH = 'f'.repeat(64);

const DECISION = {
  question: 'Should the stricter bound remain in place?',
  recommendation: 'Keep the stricter bound until the follow-up lands.',
  options: [
    { label: 'Keep the stricter bound', action: 'accept' as const },
    { label: 'Relax the bound', action: 'correct' as const },
  ],
};

type Checkpoint = Extract<RunEvent, { readonly type: 'publication-checkpoint' }>;

type Opened = Extract<RunEvent, { readonly type: 'decision-opened' }>;

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(label: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), `foundry-decision-${label}-`));
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
      payload: { taskId: 'TASK-DECISION' },
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
          decision: DECISION,
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
      openResultPullRequest: () =>
        Effect.die(new Error('decision publication tests must not open a result pull request')),
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
      listIssueCommentsAfter: () => Effect.succeed({ comments: [], truncated: false }),
      collaboratorPermission: () => Effect.succeed({ permission: 'maintain' }),
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

function runGitHarness(
  observation: ImplementationObservation = defaultImplementation,
): Layer.Layer<RunGit> {
  const unused = (name: string) =>
    Effect.die(new Error(`decision publication tests must not call RunGit.${name}`));
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
      commitExists: () => unused('commitExists'),
      readBranch: () => unused('readBranch'),
      createBranch: () => unused('createBranch'),
      readWorktree: () => unused('readWorktree'),
      createWorktree: () => unused('createWorktree'),
      observeImplementation: () => Effect.succeed(observation),
    }),
  );
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

interface PublishHarness {
  readonly github: GitHubHarness;
  readonly layers: Layer.Layer<GitHubPublication | RunGit | ReadinessGit | RunHistoryStorage>;
}

function publishHarness(
  options: {
    readonly lookup?: GitHubPullRequestLookup;
    readonly observation?: ImplementationObservation;
    readonly mergeBaseExitCode?: number;
  } = {},
): PublishHarness {
  const github = githubHarness(options.lookup ?? { kind: 'absent' });
  const layers = Layer.mergeAll(
    RunHistoryLive,
    github.layer,
    runGitHarness(options.observation ?? defaultImplementation),
    readinessGitHarness(options.mergeBaseExitCode ?? 0),
  );
  return { github, layers };
}

function runPublish(
  fixture: Fixture,
  configuration: ProjectConfiguration,
  harness: PublishHarness,
) {
  return publishDecisionDraftPr({
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

function openedOf(events: ReadonlyArray<RunEvent>): Opened['payload'] | null {
  const found = events.find((event): event is Opened => event.type === 'decision-opened');
  return found === undefined ? null : found.payload;
}

describe('decision publication', () => {
  it.effect('creates one draft decision PR and records the checkpoint journal', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('create');
      try {
        yield* seedPublishing(fixture.runDirectory);
        const configuration = yield* publicationConfiguration();
        const harness = publishHarness();
        const report = yield* runPublish(fixture, configuration, harness);

        expect(report.state).toBe('human_decision_required');
        expect(report.draftPrUrl).toBe(`https://github.com/${REPOSITORY}/pull/7`);
        expect(harness.github.calls.push).toHaveLength(1);
        expect(harness.github.calls.create).toHaveLength(1);
        expect(harness.github.calls.refresh).toHaveLength(0);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('human_decision_required');

        const opened = openedOf(after.events);
        if (opened === null) {
          throw new Error('Expected a decision-opened event.');
        }
        expect(opened.nonce).toMatch(/^[0-9a-f]{32}$/u);
        expect(opened.decisionId).toMatch(/^[0-9a-f-]{36}$/u);
        expect(opened.resultCommit).toBe(RESULT_COMMIT);
        expect(opened.options.map((option) => option.id)).toEqual(['OPT-001', 'OPT-002']);

        const checkpoints = checkpointsOf(after.events);
        expect(checkpoints.map((checkpoint) => checkpoint.stage)).toEqual([
          'pre-push',
          'pushed',
          'pull-request-located',
          'pull-request-created',
          'url-recorded',
        ]);
        for (const checkpoint of checkpoints) {
          if (checkpoint.stage === 'url-recorded') {
            expect(checkpoint.draftPrUrl).toBe(report.draftPrUrl);
          } else {
            expect(checkpoint.draftPrUrl).toBeNull();
          }
          expect(checkpoint.decisionId).toBe(opened.decisionId);
        }

        expect(report.exactCommands).toEqual([
          `/foundry decide ${RUN_ID} ${opened.decisionId} OPT-001 ${opened.nonce}`,
          `/foundry decide ${RUN_ID} ${opened.decisionId} OPT-002 ${opened.nonce}`,
        ]);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('reuses an exact open draft PR without creating a second one', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('reuse');
      try {
        yield* seedPublishing(fixture.runDirectory);
        const configuration = yield* publicationConfiguration();
        const existing: GitHubPullRequest = {
          number: 3,
          url: `https://github.com/${REPOSITORY}/pull/3`,
          draft: true,
          headBranch: TASK_BRANCH,
          headCommit: RESULT_COMMIT,
          baseBranch: 'main',
        };
        const harness = publishHarness({ lookup: { kind: 'exact', pullRequest: existing } });
        const report = yield* runPublish(fixture, configuration, harness);

        expect(report.state).toBe('human_decision_required');
        expect(report.draftPrUrl).toBe(existing.url);
        expect(harness.github.calls.create).toHaveLength(0);
        expect(harness.github.calls.refresh).toHaveLength(1);
        expect(harness.github.calls.push).toHaveLength(1);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('human_decision_required');
        expect(checkpointsOf(after.events).map((checkpoint) => checkpoint.stage)).toEqual([
          'pre-push',
          'pushed',
          'pull-request-located',
          'url-recorded',
        ]);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('refuses ambiguous existing pull requests without creating or force-pushing', () =>
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
          yield* seedPublishing(fixture.runDirectory);
          const configuration = yield* publicationConfiguration();
          const harness = publishHarness({ lookup });
          const report = yield* runPublish(fixture, configuration, harness);

          expect(report.state, JSON.stringify(lookup)).toBe('publish_failed');
          expect(report.draftPrUrl).toBeNull();
          expect(harness.github.calls.create).toHaveLength(0);
          expect(harness.github.calls.refresh).toHaveLength(0);
          expect(harness.github.calls.push).toHaveLength(1);
          expect(harness.github.calls.push[0]?.commit).toBe(RESULT_COMMIT);

          const after = yield* history(fixture.runDirectory);
          expect(after.derived.state, JSON.stringify(lookup)).toBe('publish_failed');
        } finally {
          fixture.cleanup();
        }
      }
    }),
  );

  it.effect('fails publication without remote side effects when it is not configured', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('unconfigured');
      try {
        yield* seedPublishing(fixture.runDirectory);
        const configuration = yield* publicationConfiguration(false);
        const harness = publishHarness();
        const report = yield* runPublish(fixture, configuration, harness);

        expect(report.state).toBe('publish_failed');
        expect(harness.github.calls.lookupRepositoryIdentity).toBe(0);
        expect(harness.github.calls.lookupExactPullRequest).toBe(0);
        expect(harness.github.calls.create).toHaveLength(0);
        expect(harness.github.calls.push).toHaveLength(0);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('publish_failed');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('blocks a human decision when publication is not eligible', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('blocked');
      try {
        yield* seedReviewing(fixture.runDirectory);
        const harness = publishHarness();
        const assessment: ReviewerEvidenceAssessment = {
          reviewableCommit: RESULT_COMMIT,
          evidenceCommitMatches: true,
          checksPassed: true,
          testerRequired: false,
          runtimeEvidencePresent: true,
          noChangeCandidate: false,
          correctionRoundsRemaining: 1,
          testerRetriesRemaining: 1,
          publicationEligible: false,
        };
        const disposition = yield* handleReviewerTurn({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          control: {
            schemaVersion: 1,
            outcome: 'human_decision_required',
            decision: DECISION,
          } satisfies Schema.Json,
          assessment,
          narrative: 'A person must choose a bound.',
          correctionReason: 'correction requested',
          blockedReason: 'reviewer reported a problem',
        }).pipe(
          Effect.provide(Layer.mergeAll(RunHistoryLive, harness.github.layer, runGitHarness())),
        );

        expect(disposition.kind).toBe('blocked');
        expect(harness.github.calls.lookupRepositoryIdentity).toBe(0);
        expect(harness.github.calls.lookupExactPullRequest).toBe(0);
        expect(harness.github.calls.create).toHaveLength(0);
        expect(harness.github.calls.push).toHaveLength(0);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('blocked');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('blocks publication when the frozen source is no longer contained remotely', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('rewritten');
      try {
        yield* seedPublishing(fixture.runDirectory);
        const configuration = yield* publicationConfiguration();
        const harness = publishHarness({ mergeBaseExitCode: 1 });
        const report = yield* runPublish(fixture, configuration, harness);

        expect(report.state).toBe('publish_failed');
        expect(harness.github.calls.create).toHaveLength(0);
        expect(harness.github.calls.push).toHaveLength(0);

        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('publish_failed');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('blocks publication when the task branch is not clean at the result commit', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('dirty');
      try {
        yield* seedPublishing(fixture.runDirectory);
        const configuration = yield* publicationConfiguration();
        const harness = publishHarness({
          observation: { ...defaultImplementation, clean: false },
        });
        const report = yield* runPublish(fixture, configuration, harness);

        expect(report.state).toBe('publish_failed');
        expect(harness.github.calls.create).toHaveLength(0);
        expect(harness.github.calls.push).toHaveLength(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('describes the question, options, and commands without approval claims', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('body');
      try {
        yield* seedPublishing(fixture.runDirectory);
        const configuration = yield* publicationConfiguration();
        const harness = publishHarness();
        yield* runPublish(fixture, configuration, harness);

        const created = harness.github.calls.create[0];
        if (created === undefined) {
          throw new Error('Expected a created draft pull request.');
        }
        const body = created.body;
        expect(created.title).toContain(RUN_ID);
        expect(body).toContain(DECISION.question);
        expect(body).toContain(DECISION.recommendation);
        expect(body).toContain('Keep the stricter bound');
        expect(body).toContain('Relax the bound');
        expect(body).toContain('AC-001');
        expect(body).toContain(RUN_ID);
        expect(body).toMatch(/\/foundry decide RUN-DECISION [0-9a-f-]{36} OPT-001 [0-9a-f]{32}/u);
        expect(body).not.toMatch(/approved/iu);
        expect(body).not.toMatch(/ready to merge/iu);
        expect(body).not.toMatch(/merge-ready/iu);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
