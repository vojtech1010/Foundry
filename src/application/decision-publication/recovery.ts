import { Effect, Result } from 'effect';

import { renderDecisionDraftPrBody } from '../../domain/decision-publication.js';
import { publicationRemoteMatchesSource } from '../../domain/project-configuration.js';
import {
  githubRepositoriesMatch,
  parseGitHubRepositoryRemote,
  renderGitHubRepository,
} from '../../domain/readiness.js';

import { RunGit } from '../git-provisioning/index.js';
import { ReadinessGit } from '../readiness/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';
import { transitionWorkflow } from '../workflow-transitions/index.js';

import { GitHubPublication } from './index.js';

import type {
  DecisionOpenedPayload,
  PublicationCheckpointStage,
} from '../../domain/decision-publication.js';
import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type { PublicationReconciliationAgreement, RunEvent } from '../../domain/run-history.js';
import type { RunHistoryStorage } from '../run-history/index.js';
import type { PublishDecisionDraftPrError } from './index.js';

export interface ReconcilePublicationOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly configuration: ProjectConfiguration;
}

/**
 * The outcome of reconciling an uncertain decision publication in place. A
 * `reconciled` result means the journal and GitHub now agree on an exact draft
 * PR URL and the run re-entered `human_decision_required`; `still-uncertain`
 * means the run stayed `publish_failed` with its evidence preserved; `waiting`
 * means the run already holds a durable draft and awaits an authenticated
 * decision command.
 */
export type ReconcilePublicationReport =
  | { readonly outcome: 'reconciled'; readonly draftPrUrl: string }
  | { readonly outcome: 'still-uncertain'; readonly problem: string }
  | { readonly outcome: 'waiting' };

function stillUncertain(problem: string): ReconcilePublicationReport {
  return { outcome: 'still-uncertain', problem };
}

function isPublicationCheckpoint(
  event: RunEvent,
): event is Extract<RunEvent, { readonly type: 'publication-checkpoint' }> {
  return event.type === 'publication-checkpoint';
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
 * Resumes one run that stopped `publish_failed` and finishes the exact same
 * decision publication without creating a new run, branch, or pull request.
 *
 * The recorded checkpoint journal and GitHub must agree before the run may leave
 * `publish_failed`: recovery re-pushes the exact task branch only when a push is
 * not yet journaled, reuses or creates the one exact draft pair, and appends only
 * the missing checkpoints in stage order. Success is recorded only after the
 * exact draft URL is durable (`url-recorded`), never from a branch or an
 * arbitrary pull request.
 */
export const reconcilePublication = Effect.fn('reconcilePublication')(function* (
  options: ReconcilePublicationOptions,
): Effect.fn.Return<
  ReconcilePublicationReport,
  PublishDecisionDraftPrError,
  GitHubPublication | RunGit | ReadinessGit | RunHistoryStorage
> {
  const { runDirectory, runId, configuration } = options;
  const history = yield* readVerifiedRunHistory({ runDirectory, runId, createIfMissing: false });
  const state = history.derived.state;
  if (state === 'human_decision_required') {
    return { outcome: 'waiting' } as const;
  }
  if (state !== 'publish_failed') {
    return stillUncertain(
      `run "${runId}" is in "${state ?? 'no recorded state'}", not "publish_failed"`,
    );
  }

  const publication = configuration.decisionPublication;
  const implementation = history.derived.implementation;
  const worktree = history.derived.worktreeReady;
  const resultCommit = implementation?.commit ?? null;
  if (
    publication === null ||
    implementation === null ||
    worktree === null ||
    resultCommit === null
  ) {
    return stillUncertain(
      'publication cannot be reconciled without a configured publication, a recorded implementation, worktree, and result commit',
    );
  }
  if (!publicationRemoteMatchesSource(configuration.sourceRemote, publication.remote)) {
    return stillUncertain(
      `publication remote "${publication.remote}" is not the configured source remote "${configuration.sourceRemote}"`,
    );
  }
  const opened = openedDecisionFor(history.events, resultCommit);
  if (opened === null) {
    return stillUncertain(
      'no durably opened decision is recorded for the reviewable result commit',
    );
  }
  const decisionId = opened.decisionId;

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
    return stillUncertain(identity.failure.message);
  }
  const reference = parseGitHubRepositoryRemote(identity.success.remoteUrl);
  if (reference === undefined) {
    return stillUncertain(`publication remote "${publication.remote}" is not a GitHub repository`);
  }
  const repository = renderGitHubRepository(reference);
  const observedIdentity = yield* github
    .lookupRepositoryIdentity({ repository })
    .pipe(Effect.result);
  if (
    Result.isFailure(observedIdentity) ||
    !githubRepositoriesMatch(observedIdentity.success.repository, repository)
  ) {
    return stillUncertain(
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
    return stillUncertain(observation.failure.message);
  }
  if (
    !observation.success.workspaceExists ||
    observation.success.currentBranch !== implementation.taskBranch ||
    observation.success.headCommit !== resultCommit ||
    !observation.success.clean ||
    !observation.success.baseIsAncestor
  ) {
    return stillUncertain(
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
    return stillUncertain(remoteSource.failure.message);
  }
  const containsFrozen = yield* readinessGit
    .run(
      ['merge-base', '--is-ancestor', implementation.baseCommit, remoteSource.success.commit],
      configuration.targetRepository,
    )
    .pipe(Effect.result);
  if (Result.isFailure(containsFrozen) || containsFrozen.success.exitCode !== 0) {
    return stillUncertain(
      `the frozen source commit ${implementation.baseCommit} is no longer contained by remote "${configuration.sourceRemote}/${configuration.sourceBranch}"`,
    );
  }

  const checkpoints = history.events
    .filter(isPublicationCheckpoint)
    .filter((checkpoint) => checkpoint.payload.decisionId === decisionId);
  const stages = checkpoints.map((checkpoint) => checkpoint.payload.stage);
  const hasStage = (stage: PublicationCheckpointStage): boolean => stages.includes(stage);
  const lastStage = stages.at(-1) ?? null;
  const recordedUrl =
    [...checkpoints].reverse().find((checkpoint) => checkpoint.payload.stage === 'url-recorded')
      ?.payload.draftPrUrl ?? null;
  const agreement: PublicationReconciliationAgreement =
    lastStage === 'url-recorded'
      ? 'draft-url'
      : lastStage === 'pull-request-located' || lastStage === 'pull-request-created'
        ? 'pull-request'
        : 'push';

  const resumed = yield* transitionWorkflow({
    runDirectory,
    runId,
    request: { route: 'resume', prerequisiteValid: true },
  }).pipe(Effect.result);
  if (Result.isFailure(resumed)) {
    return stillUncertain(resumed.failure.message);
  }

  const fail = Effect.fn('reconcilePublication.fail')(function* (problem: string) {
    yield* transitionWorkflow({
      runDirectory,
      runId,
      request: { route: 'publication-unresolved', cannotReconcileSafely: true },
    }).pipe(Effect.ignore);
    return stillUncertain(problem);
  });

  const appendCheckpoint = Effect.fn('reconcilePublication.appendCheckpoint')(function* (
    stage: PublicationCheckpointStage,
    draftPrUrl: string | null,
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

  if (!hasStage('pre-push')) {
    yield* appendCheckpoint(
      'pre-push',
      null,
      `reconciled a clean task branch at ${resultCommit} for ${repository}`,
    );
  }
  if (!hasStage('pushed')) {
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
      return yield* fail(pushed.failure.message);
    }
    yield* appendCheckpoint(
      'pushed',
      null,
      `reconciled ${implementation.taskBranch} at ${resultCommit} on ${publication.remote}`,
    );
  }

  const body = renderDecisionDraftPrBody({
    runId,
    decisionId,
    nonce: opened.nonce,
    question: opened.question,
    recommendation: opened.recommendation,
    options: opened.options,
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
    return yield* fail(lookup.failure.message);
  }
  if (lookup.success.kind === 'ambiguous') {
    return yield* fail(lookup.success.detail);
  }

  let draftPrUrl: string;
  if (lookup.success.kind === 'exact') {
    const existing = lookup.success.pullRequest;
    if (recordedUrl !== null && recordedUrl !== existing.url) {
      return yield* fail(
        `the recorded draft PR URL ${recordedUrl} does not match the exact pull request ${existing.url}`,
      );
    }
    if (!hasStage('pull-request-located')) {
      yield* appendCheckpoint(
        'pull-request-located',
        null,
        `reconciled the exact open draft PR #${existing.number}`,
      );
    }
    const refreshed = yield* github
      .refreshOwnedDraftPullRequestBody({
        repository,
        pullRequestNumber: existing.number,
        body,
      })
      .pipe(Effect.result);
    if (Result.isFailure(refreshed)) {
      return yield* fail(refreshed.failure.message);
    }
    draftPrUrl = refreshed.success.url;
  } else {
    if (recordedUrl !== null) {
      return yield* fail(
        `the recorded draft PR URL ${recordedUrl} is not an open draft pull request`,
      );
    }
    if (!hasStage('pull-request-located')) {
      yield* appendCheckpoint(
        'pull-request-located',
        null,
        'no exact open draft PR exists while reconciling',
      );
    }
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
      return yield* fail(created.failure.message);
    }
    if (!hasStage('pull-request-created')) {
      yield* appendCheckpoint(
        'pull-request-created',
        null,
        `created draft PR #${created.success.number}`,
      );
    }
    draftPrUrl = created.success.url;
  }

  if (!hasStage('url-recorded')) {
    yield* appendCheckpoint('url-recorded', draftPrUrl, `recorded ${draftPrUrl}`);
  }

  yield* appendRunEvent({
    runDirectory,
    runId,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'publication-reconciled',
        payload: {
          agreement,
          detail: `reconciled from the recorded ${lastStage ?? 'initial'} checkpoint to ${draftPrUrl}`,
        },
      } as const),
  });

  const reconciled = yield* transitionWorkflow({
    runDirectory,
    runId,
    request: { route: 'draft-pr-reconciled', draftPrUrl },
  }).pipe(Effect.result);
  if (Result.isFailure(reconciled)) {
    return yield* fail(reconciled.failure.message);
  }
  return { outcome: 'reconciled', draftPrUrl } as const;
});
