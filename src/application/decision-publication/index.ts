import { Context, Effect, Result, Schema } from 'effect';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  exactDecisionCommands,
  labeledDecisionOptions,
  renderDecisionDraftPrBody,
} from '../../domain/decision-publication.js';
import { publicationRemoteMatchesSource } from '../../domain/project-configuration.js';
import {
  githubRepositoriesMatch,
  parseGitHubRepositoryRemote,
  renderGitHubRepository,
} from '../../domain/readiness.js';
import { decodeReviewerTurnControl } from '../../domain/reviewer-outcomes.js';

import { RunGit } from '../git-provisioning/index.js';
import { ReadinessGit } from '../readiness/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';
import { transitionWorkflow } from '../workflow-transitions/index.js';

import type {
  DecisionOpenedPayload,
  PublicationCheckpointStage,
} from '../../domain/decision-publication.js';
import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type { ReviewerDecision } from '../../domain/reviewer-outcomes.js';
import type { RunEvent } from '../../domain/run-history.js';
import type { RunStateUnavailable } from '../run-identity/index.js';
import type { ReadinessError } from '../readiness/index.js';
import type { RunWorkspaceBlocked } from '../git-provisioning/index.js';
import type {
  RunHistoryError,
  RunHistoryStorage,
  VerifiedRunHistory,
} from '../run-history/index.js';
import type { IllegalWorkflowTransition } from '../workflow-transitions/index.js';

export class GitHubPublicationError extends Schema.TaggedError<GitHubPublicationError>()(
  'GitHubPublicationError',
  {
    message: Schema.String,
    operation: Schema.String,
    repository: Schema.String,
    detail: Schema.String,
  },
) {}

export interface GitHubRepositoryIdentity {
  readonly repository: string;
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly url: string;
  readonly draft: boolean;
  readonly headBranch: string;
  readonly headCommit: string;
  readonly baseBranch: string;
}

export type GitHubPullRequestLookup =
  | { readonly kind: 'exact'; readonly pullRequest: GitHubPullRequest }
  | { readonly kind: 'absent' }
  | { readonly kind: 'ambiguous'; readonly detail: string };

export interface GitHubPullRequestLookupRequest {
  readonly repository: string;
  readonly headBranch: string;
  readonly headCommit: string;
  readonly baseBranch: string;
}

export interface GitHubCreatePullRequestOptions {
  readonly repository: string;
  readonly title: string;
  readonly body: string;
  readonly headBranch: string;
  readonly baseBranch: string;
}

export interface GitHubRefreshPullRequestBodyOptions {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly body: string;
}

export interface GitHubPushTaskBranchOptions {
  readonly repositoryPath: string;
  readonly remote: string;
  readonly taskBranch: string;
  readonly commit: string;
  readonly runId: string;
}

/**
 * One issue comment as the decision scanner sees it. `authorType` lets the
 * application ignore bot comments without a second lookup, and `createdAt` is
 * the watermark the scanner orders against.
 */
export interface GitHubIssueComment {
  readonly commentId: string;
  readonly author: string;
  readonly authorType: 'User' | 'Bot';
  readonly body: string;
  readonly createdAt: string;
}

/**
 * A page of issue comments. `truncated` is true when the adapter could not
 * prove it saw every comment after the watermark, so the scanner refuses to
 * guess and reports the ambiguity instead.
 */
export interface GitHubIssueCommentPage {
  readonly comments: ReadonlyArray<GitHubIssueComment>;
  readonly truncated: boolean;
}

export interface GitHubCollaboratorPermission {
  readonly permission: string;
}

export interface GitHubIssueCommentsAfterOptions {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly after: string;
}

export interface GitHubCollaboratorPermissionOptions {
  readonly repository: string;
  readonly username: string;
}

/**
 * The only GitHub and remote-Git operations Foundry exposes for publication.
 * Merge, close, approval, review submission, and arbitrary branch mutation have
 * no method here and therefore no route through the application.
 */
export class GitHubPublication extends Context.Service<
  GitHubPublication,
  {
    readonly lookupRepositoryIdentity: (options: {
      readonly repository: string;
    }) => Effect.Effect<GitHubRepositoryIdentity, GitHubPublicationError>;
    readonly lookupExactPullRequest: (
      options: GitHubPullRequestLookupRequest,
    ) => Effect.Effect<GitHubPullRequestLookup, GitHubPublicationError>;
    readonly createDraftPullRequest: (
      options: GitHubCreatePullRequestOptions,
    ) => Effect.Effect<GitHubPullRequest, GitHubPublicationError>;
    readonly refreshOwnedDraftPullRequestBody: (
      options: GitHubRefreshPullRequestBodyOptions,
    ) => Effect.Effect<GitHubPullRequest, GitHubPublicationError>;
    readonly pushTaskBranch: (
      options: GitHubPushTaskBranchOptions,
    ) => Effect.Effect<void, GitHubPublicationError>;
    readonly listIssueCommentsAfter: (
      options: GitHubIssueCommentsAfterOptions,
    ) => Effect.Effect<GitHubIssueCommentPage, GitHubPublicationError>;
    readonly collaboratorPermission: (
      options: GitHubCollaboratorPermissionOptions,
    ) => Effect.Effect<GitHubCollaboratorPermission, GitHubPublicationError>;
  }
>()('foundry/application/decision-publication/GitHubPublication') {}

export interface PublishDecisionDraftPrOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly configuration: ProjectConfiguration;
}

export interface PublishDecisionDraftPrReport {
  readonly state: 'human_decision_required' | 'publish_failed';
  readonly draftPrUrl: string | null;
  readonly exactCommands: ReadonlyArray<string>;
}

export type PublishDecisionDraftPrError =
  | RunHistoryError
  | RunStateUnavailable
  | IllegalWorkflowTransition
  | RunWorkspaceBlocked
  | ReadinessError;

function reviewerDecisionOf(history: VerifiedRunHistory): ReviewerDecision | null {
  let found: ReviewerDecision | null = null;
  for (const session of history.derived.roleSessions) {
    if (session.role !== 'reviewer') {
      continue;
    }
    const control = session.lastObservation?.control ?? null;
    if (control === null) {
      continue;
    }
    const decoded = decodeReviewerTurnControl(control);
    if (decoded.ok && decoded.control.outcome === 'human_decision_required') {
      found = decoded.control.decision;
    }
  }
  return found;
}

function openedDecisionFor(
  events: ReadonlyArray<RunEvent>,
  resultCommit: string,
): DecisionOpenedPayload | null {
  for (const event of events) {
    if (event.type === 'decision-opened' && event.payload.resultCommit === resultCommit) {
      return event.payload;
    }
  }
  return null;
}

/**
 * Executes the `publishing` stage for one recorded human decision: pre-flight,
 * non-force push of the exact result commit, exact-pair draft PR reuse or
 * creation, and the durable checkpoint journal. Any condition that cannot be
 * reconciled safely records `publish_failed` instead of guessing; a successful
 * publication records the draft PR URL and enters `human_decision_required`.
 */
export const publishDecisionDraftPr = Effect.fn('publishDecisionDraftPr')(function* (
  options: PublishDecisionDraftPrOptions,
): Effect.fn.Return<
  PublishDecisionDraftPrReport,
  PublishDecisionDraftPrError,
  GitHubPublication | RunGit | ReadinessGit | RunHistoryStorage
> {
  const { runDirectory, runId, configuration } = options;
  const publication = configuration.decisionPublication;
  const history = yield* readVerifiedRunHistory({ runDirectory, runId, createIfMissing: false });

  const unresolved = Effect.fn('publishDecisionDraftPr.unresolved')(function* (detail: string) {
    yield* transitionWorkflow({
      runDirectory,
      runId,
      request: { route: 'publication-unresolved', cannotReconcileSafely: true },
    });
    yield* Effect.logWarning(`decision publication unresolved for ${runId}: ${detail}`);
    return {
      state: 'publish_failed',
      draftPrUrl: null,
      exactCommands: [],
    } satisfies PublishDecisionDraftPrReport;
  });

  const appendCheckpoint = Effect.fn('publishDecisionDraftPr.appendCheckpoint')(function* (
    stage: PublicationCheckpointStage,
    draftPrUrl: string | null,
    decisionId: string,
    detail: string,
  ) {
    yield* appendRunEvent({
      runDirectory,
      runId,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'publication-checkpoint',
          payload: { stage, draftPrUrl, decisionId, detail },
        } as const),
    });
  });

  if (publication === null) {
    return yield* unresolved('decision publication is not configured for this repository');
  }
  const implementation = history.derived.implementation;
  const worktree = history.derived.worktreeReady;
  const resultCommit = implementation?.commit ?? null;
  if (implementation === null || worktree === null || resultCommit === null) {
    return yield* unresolved('no reviewable result commit is recorded for publication');
  }
  if (!publicationRemoteMatchesSource(configuration.sourceRemote, publication.remote)) {
    return yield* unresolved(
      `publication remote "${publication.remote}" is not the configured source remote "${configuration.sourceRemote}"`,
    );
  }

  const decision = reviewerDecisionOf(history);
  if (decision === null) {
    return yield* unresolved('no human-decision envelope is recorded for this run');
  }
  const labeledOptions = labeledDecisionOptions(decision);

  const priorOpened = openedDecisionFor(history.events, resultCommit);
  const decisionId = priorOpened?.decisionId ?? randomUUID();
  const nonce = priorOpened?.nonce ?? randomBytes(16).toString('hex');
  const openedOptions = priorOpened?.options ?? labeledOptions;
  const exactCommands = exactDecisionCommands({
    runId,
    decisionId,
    nonce,
    options: openedOptions,
  });

  if (priorOpened === null) {
    yield* appendRunEvent({
      runDirectory,
      runId,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'decision-opened',
          payload: {
            decisionId,
            nonce,
            question: decision.question,
            recommendation: decision.recommendation ?? null,
            options: labeledOptions,
            resultCommit,
          },
        } as const),
    });
  }

  const git = yield* RunGit;
  const readinessGit = yield* ReadinessGit;
  const github = yield* GitHubPublication;

  const identity = yield* git
    .inspectRepository({
      repositoryRoot: configuration.targetRepository,
      remote: publication.remote,
      runId,
    })
    .pipe(Effect.result);
  if (Result.isFailure(identity)) {
    return yield* unresolved(identity.failure.message);
  }
  const reference = parseGitHubRepositoryRemote(identity.success.remoteUrl);
  if (reference === undefined) {
    return yield* unresolved(
      `publication remote "${publication.remote}" is not a GitHub repository`,
    );
  }
  const repository = renderGitHubRepository(reference);
  const observedIdentity = yield* github
    .lookupRepositoryIdentity({ repository })
    .pipe(Effect.result);
  if (
    Result.isFailure(observedIdentity) ||
    !githubRepositoriesMatch(observedIdentity.success.repository, repository)
  ) {
    return yield* unresolved(
      `GitHub repository identity could not be confirmed for the configured publication remote "${publication.remote}"`,
    );
  }

  const observation = yield* git
    .observeImplementation({
      workspace: worktree.workspace,
      taskBranch: implementation.taskBranch,
      baseCommit: implementation.baseCommit,
      runId,
    })
    .pipe(Effect.result);
  if (Result.isFailure(observation)) {
    return yield* unresolved(observation.failure.message);
  }
  if (
    !observation.success.workspaceExists ||
    observation.success.currentBranch !== implementation.taskBranch ||
    observation.success.headCommit !== resultCommit ||
    !observation.success.clean ||
    !observation.success.baseIsAncestor
  ) {
    return yield* unresolved(
      `task branch "${implementation.taskBranch}" is not clean at the recorded result commit ${resultCommit}`,
    );
  }

  const remoteSource = yield* git
    .fetchSource({
      repositoryRoot: configuration.targetRepository,
      remote: configuration.sourceRemote,
      branch: configuration.sourceBranch,
      runId,
    })
    .pipe(Effect.result);
  if (Result.isFailure(remoteSource)) {
    return yield* unresolved(remoteSource.failure.message);
  }
  const containsFrozen = yield* readinessGit
    .run(
      ['merge-base', '--is-ancestor', implementation.baseCommit, remoteSource.success.commit],
      configuration.targetRepository,
    )
    .pipe(Effect.result);
  if (Result.isFailure(containsFrozen) || containsFrozen.success.exitCode !== 0) {
    return yield* unresolved(
      `the frozen source commit ${implementation.baseCommit} is no longer contained by remote "${configuration.sourceRemote}/${configuration.sourceBranch}"`,
    );
  }

  yield* appendCheckpoint(
    'pre-push',
    null,
    decisionId,
    `verified a clean task branch at ${resultCommit} for ${repository}`,
  );

  const pushed = yield* github
    .pushTaskBranch({
      repositoryPath: worktree.workspace,
      remote: publication.remote,
      taskBranch: implementation.taskBranch,
      commit: resultCommit,
      runId,
    })
    .pipe(Effect.result);
  if (Result.isFailure(pushed)) {
    return yield* unresolved(pushed.failure.message);
  }
  yield* appendCheckpoint(
    'pushed',
    null,
    decisionId,
    `pushed ${implementation.taskBranch} at ${resultCommit} to ${publication.remote}`,
  );

  const body = renderDecisionDraftPrBody({
    runId,
    decisionId,
    nonce,
    question: decision.question,
    recommendation: decision.recommendation ?? null,
    options: openedOptions,
    sourceCommit: implementation.baseCommit,
    resultCommit,
    criteria: history.derived.acceptedPlan?.criteria ?? [],
  });
  const title = `Human decision required for ${runId}`;

  const lookup = yield* github
    .lookupExactPullRequest({
      repository,
      headBranch: implementation.taskBranch,
      headCommit: resultCommit,
      baseBranch: configuration.sourceBranch,
    })
    .pipe(Effect.result);
  if (Result.isFailure(lookup)) {
    return yield* unresolved(lookup.failure.message);
  }
  if (lookup.success.kind === 'ambiguous') {
    return yield* unresolved(lookup.success.detail);
  }

  let draftPrUrl: string;
  if (lookup.success.kind === 'exact') {
    const existing = lookup.success.pullRequest;
    yield* appendCheckpoint(
      'pull-request-located',
      null,
      decisionId,
      `reusing exact open draft PR #${existing.number}`,
    );
    const refreshed = yield* github
      .refreshOwnedDraftPullRequestBody({
        repository,
        pullRequestNumber: existing.number,
        body,
      })
      .pipe(Effect.result);
    if (Result.isFailure(refreshed)) {
      return yield* unresolved(refreshed.failure.message);
    }
    draftPrUrl = refreshed.success.url;
  } else {
    yield* appendCheckpoint(
      'pull-request-located',
      null,
      decisionId,
      'no exact open draft PR exists',
    );
    const created = yield* github
      .createDraftPullRequest({
        repository,
        title,
        body,
        headBranch: implementation.taskBranch,
        baseBranch: configuration.sourceBranch,
      })
      .pipe(Effect.result);
    if (Result.isFailure(created)) {
      return yield* unresolved(created.failure.message);
    }
    yield* appendCheckpoint(
      'pull-request-created',
      null,
      decisionId,
      `created draft PR #${created.success.number}`,
    );
    draftPrUrl = created.success.url;
  }

  yield* appendCheckpoint('url-recorded', draftPrUrl, decisionId, `recorded ${draftPrUrl}`);
  yield* transitionWorkflow({
    runDirectory,
    runId,
    request: { route: 'draft-pr-reconciled', draftPrUrl },
  });
  return {
    state: 'human_decision_required',
    draftPrUrl,
    exactCommands,
  } satisfies PublishDecisionDraftPrReport;
});

export { reconcilePublication } from './recovery.js';
