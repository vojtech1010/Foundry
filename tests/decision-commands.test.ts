import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyDecision, scanForDecision } from '../src/application/decision-commands/index.js';
import {
  GitHubPublication,
  GitHubPublicationError,
} from '../src/application/decision-publication/index.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { buildHandoff, completionOf } from '../src/application/handoff/index.js';
import { decodeProjectConfiguration } from '../src/application/project-configuration.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { correctionRoundsUsed } from '../src/application/run-workflow/index.js';
import { buildRunStatus } from '../src/application/status/index.js';
import { decisionOptionCommand } from '../src/domain/decision-publication.js';
import { renderDecisionCommand } from '../src/domain/inspection.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { goldenConfigurationDocument } from './fixtures/checks-runtime-run.js';

import type {
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubPullRequestLookup,
} from '../src/application/decision-publication/index.js';
import type { RunEventDraft } from '../src/domain/run-history.js';
import type { RunEvent } from '../src/domain/run-history.js';

const RUN_ID = 'RUN-DECISION';

const FROZEN_COMMIT = 'a'.repeat(40);

const RESULT_COMMIT = 'b'.repeat(40);

const RESULT_COMMIT_TWO = 'd'.repeat(40);

const TASK_BRANCH = 'foundry/RUN-DECISION';

const WORKSPACE = '/target/.agent/worktrees/RUN-DECISION';

const REPOSITORY = 'example/target';

const REMOTE_URL = 'git@github.com:example/target.git';

const PUBLICATION_REMOTE = 'origin';

const GOLDEN_AGGREGATE_HASH = 'f'.repeat(64);

const DRAFT_PR_URL = `https://github.com/${REPOSITORY}/pull/7`;

const DECISION_ID = '11111111-1111-4111-8111-111111111111';

const DECISION_ID_TWO = '22222222-2222-4222-8222-222222222222';

const NONCE = '0'.repeat(32);

const NONCE_TWO = '1'.repeat(32);

const QUESTION = 'Should the stricter bound remain in place?';

const RECOMMENDATION = 'Keep the stricter bound until the follow-up lands.';

const DECISION_OPTIONS = [
  { id: 'OPT-001', label: 'Keep the stricter bound', action: 'accept' as const },
  { id: 'OPT-002', label: 'Relax the bound', action: 'correct' as const },
  { id: 'OPT-003', label: 'Stop the work', action: 'abandon' as const },
];

type GitHubCommentOptions = GitHubIssueComment;

interface Fixture {
  readonly runDirectory: string;
  readonly cleanup: () => void;
}

function setupFixture(label: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), `foundry-decision-command-${label}-`));
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

function verificationReport(commit: string) {
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

function emitImplementationCycle(
  runDirectory: string,
  from: 'coding' | 'correcting',
  commit: string,
) {
  return Effect.gen(function* () {
    yield* emit(runDirectory, false, {
      type: 'implementation-accepted',
      payload: {
        taskBranch: TASK_BRANCH,
        baseCommit: FROZEN_COMMIT,
        commit,
        changedFiles: ['src/implementation.ts'],
        noChangeCandidate: false,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'implementation-ready', from, to: 'verifying', checkpoint: null },
    });
    yield* emit(runDirectory, false, {
      type: 'verification-completed',
      payload: verificationReport(commit),
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
  });
}

function seedToReviewing(runDirectory: string) {
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
    yield* emitImplementationCycle(runDirectory, 'coding', RESULT_COMMIT);
  });
}

interface DecisionRoundOptions {
  readonly attempt: number;
  readonly commit: string;
  readonly decisionId: string;
  readonly nonce: string;
  readonly draftPrUrl: string;
}

function appendDecisionRound(runDirectory: string, options: DecisionRoundOptions) {
  const sessionId = `reviewer-session-${options.attempt}`;
  return Effect.gen(function* () {
    yield* emit(runDirectory, false, {
      type: 'role-session-created',
      payload: {
        role: 'reviewer',
        attempt: options.attempt,
        generation: options.attempt,
        sessionId,
        ownershipToken: `reviewer-owner-${options.attempt}`,
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
        sessionId,
        generation: options.attempt,
        status: 'settled',
        sequence: 1,
        eventCount: 1,
        narrative: 'A person must choose a bound.',
        control: {
          schemaVersion: 1,
          outcome: 'human_decision_required',
          decision: {
            question: QUESTION,
            recommendation: RECOMMENDATION,
            options: [
              { label: 'Keep the stricter bound', action: 'accept' },
              { label: 'Relax the bound', action: 'correct' },
            ],
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
    yield* emit(runDirectory, false, {
      type: 'decision-opened',
      payload: {
        decisionId: options.decisionId,
        nonce: options.nonce,
        question: QUESTION,
        recommendation: RECOMMENDATION,
        options: DECISION_OPTIONS,
        resultCommit: options.commit,
      },
    });
    const stages = ['pre-push', 'pushed', 'pull-request-located', 'pull-request-created'] as const;
    for (const stage of stages) {
      yield* emit(runDirectory, false, {
        type: 'publication-checkpoint',
        payload: {
          stage,
          draftPrUrl: null,
          decisionId: options.decisionId,
          detail: stage,
        },
      });
    }
    yield* emit(runDirectory, false, {
      type: 'publication-checkpoint',
      payload: {
        stage: 'url-recorded',
        draftPrUrl: options.draftPrUrl,
        decisionId: options.decisionId,
        detail: 'recorded the draft pull request URL',
      },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'draft-pr-reconciled',
        from: 'publishing',
        to: 'human_decision_required',
        checkpoint: null,
      },
    });
  });
}

function seedWaiting(runDirectory: string) {
  return Effect.gen(function* () {
    yield* seedToReviewing(runDirectory);
    yield* appendDecisionRound(runDirectory, {
      attempt: 1,
      commit: RESULT_COMMIT,
      decisionId: DECISION_ID,
      nonce: NONCE,
      draftPrUrl: DRAFT_PR_URL,
    });
  }).pipe(Effect.provide(RunHistoryLive));
}

interface GitHubStubOptions {
  readonly pullRequest?: GitHubPullRequest | null;
  readonly lookup?: GitHubPullRequestLookup;
  readonly lookupError?: GitHubPublicationError;
  readonly comments?: ReadonlyArray<GitHubCommentOptions>;
  readonly commentsTruncated?: boolean;
  readonly commentsError?: GitHubPublicationError;
  readonly permissions?: Readonly<Record<string, string>>;
  readonly permissionError?: GitHubPublicationError;
}

interface GitHubStub {
  readonly layer: Layer.Layer<GitHubPublication>;
  readonly calls: Array<string>;
}

function exactPullRequest(commit: string): GitHubPullRequest {
  return {
    number: 7,
    url: DRAFT_PR_URL,
    draft: true,
    headBranch: TASK_BRANCH,
    headCommit: commit,
    baseBranch: 'main',
  };
}

function githubStub(options: GitHubStubOptions = {}): GitHubStub {
  const calls: Array<string> = [];
  const layer = Layer.succeed(
    GitHubPublication,
    GitHubPublication.of({
      lookupRepositoryIdentity: (request) => {
        calls.push('lookupRepositoryIdentity');
        return Effect.succeed({ repository: request.repository });
      },
      lookupExactPullRequest: (_request) => {
        calls.push('lookupExactPullRequest');
        if (options.lookupError !== undefined) {
          return Effect.fail(options.lookupError);
        }
        if (options.lookup !== undefined) {
          return Effect.succeed(options.lookup);
        }
        return Effect.succeed(
          options.pullRequest === null
            ? ({ kind: 'absent' } as const)
            : {
                kind: 'exact',
                pullRequest: options.pullRequest ?? exactPullRequest(RESULT_COMMIT),
              },
        );
      },
      createDraftPullRequest: () => {
        calls.push('createDraftPullRequest');
        return Effect.die(new Error('decision commands must not create a pull request'));
      },
      openResultPullRequest: () => {
        calls.push('openResultPullRequest');
        return Effect.die(new Error('decision commands must not open a result pull request'));
      },
      refreshOwnedDraftPullRequestBody: () => {
        calls.push('refreshOwnedDraftPullRequestBody');
        return Effect.die(new Error('decision commands must not refresh a pull request'));
      },
      pushTaskBranch: () => {
        calls.push('pushTaskBranch');
        return Effect.die(new Error('decision commands must not push a branch'));
      },
      listIssueCommentsAfter: (_request) => {
        calls.push('listIssueCommentsAfter');
        if (options.commentsError !== undefined) {
          return Effect.fail(options.commentsError);
        }
        return Effect.succeed({
          comments: options.comments ?? [],
          truncated: options.commentsTruncated ?? false,
        });
      },
      collaboratorPermission: (request) => {
        calls.push('collaboratorPermission');
        if (options.permissionError !== undefined) {
          return Effect.fail(options.permissionError);
        }
        return Effect.succeed({
          permission: options.permissions?.[request.username] ?? 'maintain',
        });
      },
    }),
  );
  return { layer, calls };
}

function githubError(operation: string): GitHubPublicationError {
  return new GitHubPublicationError({
    message: `GitHub publication ${operation} failed`,
    operation,
    repository: REPOSITORY,
    detail: `${operation} could not be completed`,
  });
}

function runGitStub(): Layer.Layer<RunGit> {
  const unused = (name: string) =>
    Effect.die(new Error(`decision command tests must not call RunGit.${name}`));
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

function decisionConfiguration() {
  return decodeProjectConfiguration(
    {
      ...goldenConfigurationDocument('/target', false),
      decisionPublication: { remote: PUBLICATION_REMOTE, draft: true, maintainersCanModify: false },
    },
    '/target',
  );
}

function scan(runDirectory: string, stub: GitHubStub) {
  return Effect.gen(function* () {
    const configuration = yield* decisionConfiguration();
    return yield* scanForDecision({ runDirectory, runId: RUN_ID, configuration });
  }).pipe(Effect.provide(Layer.mergeAll(RunHistoryLive, stub.layer)));
}

function apply(runDirectory: string, decisionId: string, optionId: string) {
  const option = DECISION_OPTIONS.find((candidate) => candidate.id === optionId);
  if (option === undefined) {
    throw new Error(`Unknown test option ${optionId}`);
  }
  return applyDecision(
    { runDirectory, runId: RUN_ID },
    {
      decisionId,
      option,
      evidence: {
        commentId: '9001',
        author: 'maintainer',
        bodyHash: 'a'.repeat(64),
        permissionSnapshot: 'maintain',
      },
    },
  ).pipe(Effect.provide(Layer.mergeAll(RunHistoryLive, runGitStub())));
}

function history(runDirectory: string) {
  return readVerifiedRunHistory({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

function command(decisionId: string, optionId: string, nonce = NONCE): string {
  return `/foundry decide ${RUN_ID} ${decisionId} ${optionId} ${nonce}`;
}

function comment(body: string, overrides: Partial<GitHubIssueComment> = {}): GitHubIssueComment {
  return {
    commentId: '9001',
    author: 'maintainer',
    authorType: 'User',
    body,
    createdAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function appliedEvents(events: ReadonlyArray<RunEvent>) {
  return events.filter((event) => event.type === 'decision-applied');
}

describe('authenticated decision commands', () => {
  it.effect('waits when no exact command comment exists', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('waiting');
      try {
        yield* seedWaiting(fixture.runDirectory);
        const stub = githubStub({
          comments: [
            comment('looks good to me'),
            comment(command(DECISION_ID, 'OPT-001'), { authorType: 'Bot' }),
            comment(command(DECISION_ID, 'OPT-001'), { author: 'reader' }),
          ],
          permissions: { reader: 'read' },
        });
        const outcome = yield* scan(fixture.runDirectory, stub);

        expect(outcome.kind).toBe('waiting');
        expect(outcome.draftPrUrl).toBe(DRAFT_PR_URL);
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('human_decision_required');
        expect(appliedEvents(after.events)).toHaveLength(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('applies exactly one authenticated command and never repeats it', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('applied');
      try {
        yield* seedWaiting(fixture.runDirectory);
        const stub = githubStub({
          comments: [comment(command(DECISION_ID, 'OPT-001'))],
        });
        const outcome = yield* scan(fixture.runDirectory, stub);
        expect(outcome.kind).toBe('applied');
        if (outcome.kind !== 'applied') {
          throw new Error('expected an applied decision');
        }
        expect(outcome.option.id).toBe('OPT-001');
        expect(outcome.option.action).toBe('accept');
        expect(outcome.evidence.author).toBe('maintainer');
        expect(outcome.evidence.permissionSnapshot).toBe('maintain');
        expect(outcome.evidence.bodyHash).toMatch(/^[0-9a-f]{64}$/u);

        yield* apply(fixture.runDirectory, DECISION_ID, 'OPT-001');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('completed');
        const applied = appliedEvents(after.events);
        expect(applied).toHaveLength(1);
        expect(applied[0]?.payload).toMatchObject({
          decisionId: DECISION_ID,
          optionId: 'OPT-001',
          action: 'accept',
          commentId: '9001',
          author: 'maintainer',
          permissionSnapshot: 'maintain',
        });
        expect(
          after.events.some(
            (event) =>
              event.type === 'workflow-transition' && event.payload.route === 'human-accepted',
          ),
        ).toBe(true);

        const rescanned = yield* scan(fixture.runDirectory, stub);
        expect(rescanned.kind).toBe('applied');
        const stillOne = yield* history(fixture.runDirectory);
        expect(appliedEvents(stillOne.events)).toHaveLength(1);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('ignores repeated identical commands for the same option', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('repeated');
      try {
        yield* seedWaiting(fixture.runDirectory);
        const stub = githubStub({
          comments: [
            comment(command(DECISION_ID, 'OPT-001'), { commentId: '1' }),
            comment(command(DECISION_ID, 'OPT-001'), { commentId: '2' }),
          ],
        });
        const outcome = yield* scan(fixture.runDirectory, stub);
        expect(outcome.kind).toBe('applied');
        yield* apply(fixture.runDirectory, DECISION_ID, 'OPT-001');
        const after = yield* history(fixture.runDirectory);
        expect(appliedEvents(after.events)).toHaveLength(1);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('stops for a person when conflicting valid options were recorded', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('conflict');
      try {
        yield* seedWaiting(fixture.runDirectory);
        const stub = githubStub({
          comments: [
            comment(command(DECISION_ID, 'OPT-001'), { commentId: '1' }),
            comment(command(DECISION_ID, 'OPT-002'), { commentId: '2' }),
          ],
        });
        const outcome = yield* scan(fixture.runDirectory, stub);
        expect(outcome.kind).toBe('conflict');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('human_decision_required');
        expect(appliedEvents(after.events)).toHaveLength(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('stops for a person when the pull request identity or head changed', () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<GitHubStubOptions> = [
        { pullRequest: null },
        {
          lookup: {
            kind: 'ambiguous',
            detail: 'open non-draft pull request #4 matches the task branch',
          },
        },
        {
          pullRequest: {
            ...exactPullRequest(RESULT_COMMIT),
            url: `https://github.com/${REPOSITORY}/pull/9`,
          },
        },
      ];
      for (const options of cases) {
        const fixture = setupFixture('changed');
        try {
          yield* seedWaiting(fixture.runDirectory);
          const outcome = yield* scan(fixture.runDirectory, githubStub(options));
          expect(outcome.kind, JSON.stringify(options)).toBe('changed');
          const after = yield* history(fixture.runDirectory);
          expect(after.derived.state).toBe('human_decision_required');
          expect(appliedEvents(after.events)).toHaveLength(0);
        } finally {
          fixture.cleanup();
        }
      }
    }),
  );

  it.effect('stops for a person when author permission cannot be verified', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('unverifiable');
      try {
        yield* seedWaiting(fixture.runDirectory);
        const stub = githubStub({
          comments: [comment(command(DECISION_ID, 'OPT-001'))],
          permissionError: githubError('collaborator-permission'),
        });
        const outcome = yield* scan(fixture.runDirectory, stub);
        expect(outcome.kind).toBe('unverifiable');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('human_decision_required');
        expect(appliedEvents(after.events)).toHaveLength(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('never guesses when the comment page cannot be proven complete', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('ambiguous');
      try {
        yield* seedWaiting(fixture.runDirectory);
        const stub = githubStub({
          comments: [comment(command(DECISION_ID, 'OPT-001'))],
          commentsTruncated: true,
        });
        const outcome = yield* scan(fixture.runDirectory, stub);
        expect(outcome.kind).toBe('ambiguous');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('routes correct back to the Coder without spending an automatic round', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('correct');
      try {
        yield* seedWaiting(fixture.runDirectory);
        yield* apply(fixture.runDirectory, DECISION_ID, 'OPT-002');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('correcting');
        expect(
          after.events.some(
            (event) =>
              event.type === 'workflow-transition' && event.payload.route === 'human-corrected',
          ),
        ).toBe(true);
        expect(correctionRoundsUsed(after)).toBe(0);
        const status = buildRunStatus({
          runDirectory: fixture.runDirectory,
          history: after,
          nowMillis: 0,
        });
        expect(status.counts.corrections).toBe(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('ends an abandoned run and records the decision evidence', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('abandon');
      try {
        yield* seedWaiting(fixture.runDirectory);
        yield* apply(fixture.runDirectory, DECISION_ID, 'OPT-003');
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('abandoned');
        expect(
          after.events.some(
            (event) =>
              event.type === 'workflow-transition' && event.payload.route === 'abandon-run',
          ),
        ).toBe(true);
        expect(appliedEvents(after.events)[0]?.payload).toMatchObject({
          decisionId: DECISION_ID,
          optionId: 'OPT-003',
          action: 'abandon',
          commentId: '9001',
          author: 'maintainer',
        });
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('issues no create, refresh, push, or merge adapter call for an option', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('no-side-effects');
      try {
        yield* seedWaiting(fixture.runDirectory);
        const stub = githubStub({ comments: [comment(command(DECISION_ID, 'OPT-001'))] });
        const outcome = yield* scan(fixture.runDirectory, stub);
        expect(outcome.kind).toBe('applied');
        yield* apply(fixture.runDirectory, DECISION_ID, 'OPT-001');
        expect(stub.calls).toContain('lookupExactPullRequest');
        expect(stub.calls).toContain('listIssueCommentsAfter');
        expect(stub.calls).toContain('collaboratorPermission');
        expect(stub.calls).not.toContain('createDraftPullRequest');
        expect(stub.calls).not.toContain('refreshOwnedDraftPullRequestBody');
        expect(stub.calls).not.toContain('pushTaskBranch');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('can open a second decision round for a corrected result head', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('round-two');
      try {
        yield* seedWaiting(fixture.runDirectory);
        yield* apply(fixture.runDirectory, DECISION_ID, 'OPT-002');
        yield* emitImplementationCycle(fixture.runDirectory, 'correcting', RESULT_COMMIT_TWO).pipe(
          Effect.provide(RunHistoryLive),
        );
        yield* appendDecisionRound(fixture.runDirectory, {
          attempt: 2,
          commit: RESULT_COMMIT_TWO,
          decisionId: DECISION_ID_TWO,
          nonce: NONCE_TWO,
          draftPrUrl: DRAFT_PR_URL,
        }).pipe(Effect.provide(RunHistoryLive));
        const after = yield* history(fixture.runDirectory);
        expect(after.derived.state).toBe('human_decision_required');
        expect(after.derived.decisionApplieds).toHaveLength(1);
        const opened = after.events.filter((event) => event.type === 'decision-opened');
        expect(opened).toHaveLength(2);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it('keeps the two decision-command renderers identical', () => {
    const input = {
      runId: RUN_ID,
      decisionId: DECISION_ID,
      optionId: 'OPT-001',
      nonce: NONCE,
    };
    expect(renderDecisionCommand(input)).toBe(decisionOptionCommand(input));
  });

  it.effect('retains the applied decision in the handoff instead of Reviewer approval', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('handoff');
      try {
        yield* seedWaiting(fixture.runDirectory);
        yield* apply(fixture.runDirectory, DECISION_ID, 'OPT-001');
        const after = yield* history(fixture.runDirectory);
        const completion = completionOf(after.events);
        if (completion === null) {
          throw new Error('expected the accepted run to record a completion');
        }
        const document = buildHandoff(RUN_ID, after.derived, completion, after.events);
        expect(document.outcome).toBe('completed');
        expect(document.humanDecision.applied).toBe(true);
        expect(document.humanDecision.route).toBe('human-accepted');
        expect(document.humanDecision.evidenceRetained).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
