import { Effect, Result } from 'effect';

import { publicationRemoteMatchesSource } from '../../domain/project-configuration.js';
import {
  githubRepositoriesMatch,
  parseGitHubRepositoryRemote,
  renderGitHubRepository,
} from '../../domain/readiness.js';

import { GitHubPublication } from '../decision-publication/index.js';
import { RunGit } from '../git-provisioning/index.js';
import { ReadinessGit, describePublicationReadiness } from '../readiness/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';

import type { PublicationCheckpointStage } from '../../domain/decision-publication.js';
import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type { RunEvent, RunHistoryDerivedState } from '../../domain/run-history.js';
import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';

/**
 * The outcome of publishing the ordinary result pull request for an approved
 * changed result. `published` names the exact result PR URL; `skipped` means
 * the run legitimately completed without a result PR (publication not
 * configured or not eligible, no changed result, or no ordinary approval);
 * `uncertain` means the transaction could not be settled safely, and the same
 * run must be resumed so the journal and GitHub can be reconciled in place.
 */
export type ResultPublicationReport =
  | { readonly outcome: 'published'; readonly url: string }
  | { readonly outcome: 'skipped'; readonly reason: string }
  | { readonly outcome: 'uncertain'; readonly problem: string };

export interface PublishResultPrOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly configuration: ProjectConfiguration;
}

export type ResultPublicationError = RunHistoryError;

export interface ResultPullRequestBodyInput {
  readonly runId: string;
  readonly sourceCommit: string;
  readonly resultCommit: string;
  readonly taskBranch: string;
  readonly criteria: ReadonlyArray<{ readonly id: string; readonly text: string }>;
}

/**
 * Renders the ordinary result pull request body. It presents the approved
 * result and the exact accepted commit for the team's normal GitHub process; it
 * is never a request for human judgment and carries no authenticated Foundry
 * command.
 */
export function renderResultPullRequestBody(input: ResultPullRequestBodyInput): string {
  const lines = [
    `# Approved result for ${input.runId}`,
    '',
    'Foundry completed this run and opened the ordinary pull request for the',
    'exact approved result. This publishes the team result for review and merge',
    'through their normal GitHub process; it is not a request for human',
    'judgment and it does not mean the work is merged.',
    '',
    '## Result',
    '',
    `- Task branch: \`${input.taskBranch}\``,
    `- Source commit: \`${input.sourceCommit}\``,
    `- Approved result commit: \`${input.resultCommit}\``,
    '',
    '## Acceptance criteria',
    '',
  ];
  if (input.criteria.length === 0) {
    lines.push('- None recorded.', '');
  } else {
    for (const criterion of input.criteria) {
      lines.push(`- \`${criterion.id}\` — ${criterion.text}`);
    }
    lines.push('');
  }
  lines.push(
    '## Taking this result forward',
    '',
    "Review and merge this pull request through the team's normal GitHub process.",
    'Foundry never force-pushes, merges, closes, or rewrites history.',
    '',
  );
  return lines.join('\n');
}

function changedResultApproved(events: ReadonlyArray<RunEvent>): boolean {
  return events.some(
    (event) => event.type === 'workflow-transition' && event.payload.route === 'review-approved',
  );
}

function skipped(reason: string): ResultPublicationReport {
  return { outcome: 'skipped', reason };
}

function uncertain(problem: string): ResultPublicationReport {
  return { outcome: 'uncertain', problem };
}

function checkpointsFor(
  derived: RunHistoryDerivedState,
  commit: string,
): ReadonlyArray<Extract<RunEvent, { readonly type: 'result-pr-checkpoint' }>['payload']> {
  return (derived.resultPrCheckpoints ?? []).filter((checkpoint) => checkpoint.commit === commit);
}

/**
 * Publishes exactly one ordinary (non-draft) result pull request for the
 * approved changed result of a completed run. The function is idempotent and
 * safe to re-run: it journals `result-pr-checkpoint` stages, non-force pushes
 * the frozen task branch at the exact accepted commit from the owning
 * repository, opens or reuses the one exact non-draft pull request, and records
 * the settled `result-pr-recorded` fact. A resume therefore reconciles the same
 * run instead of opening a second run or a duplicate pull request.
 *
 * Publication is only attempted for a genuine `review-approved` changed result
 * with an eligible publication configuration. Every other run completes locally
 * with a `skipped` report and no remote side effect.
 */
export const publishResultPr = Effect.fn('publishResultPr')(function* (
  options: PublishResultPrOptions,
): Effect.fn.Return<
  ResultPublicationReport,
  ResultPublicationError,
  GitHubPublication | RunGit | ReadinessGit | RunHistoryStorage
> {
  const { runDirectory, runId, configuration } = options;
  const publication = configuration.decisionPublication;
  if (publication === null) {
    return skipped('GitHub publication is not configured for this repository');
  }
  const history = yield* readVerifiedRunHistory({ runDirectory, runId, createIfMissing: false });
  const implementation = history.derived.implementation;
  const resultCommit = implementation?.commit ?? null;
  if (implementation === null || implementation.noChangeCandidate || resultCommit === null) {
    return skipped('The completed run has no changed result commit to publish');
  }
  const alreadyRecorded = history.derived.resultPrRecorded ?? null;
  if (alreadyRecorded !== null && alreadyRecorded.commit === resultCommit) {
    return { outcome: 'published', url: alreadyRecorded.url } as const;
  }
  if (!changedResultApproved(history.events)) {
    return skipped('The run did not complete through a Reviewer approval of a changed result');
  }
  const taskBranch = implementation.taskBranch;
  if (!publicationRemoteMatchesSource(configuration.sourceRemote, publication.remote)) {
    return uncertain(
      `Publication remote "${publication.remote}" is not the configured source remote "${configuration.sourceRemote}"`,
    );
  }

  const readiness = yield* describePublicationReadiness(
    publication,
    configuration.targetRepository,
  ).pipe(Effect.result);
  if (Result.isFailure(readiness)) {
    return uncertain(readiness.failure.message);
  }
  if (!readiness.success.eligible) {
    return skipped(
      `Result publication is not eligible: ${readiness.success.reason ?? 'publication readiness could not be confirmed'}`,
    );
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
    return uncertain(identity.failure.message);
  }
  const reference = parseGitHubRepositoryRemote(identity.success.remoteUrl);
  if (reference === undefined) {
    return uncertain(`Publication remote "${publication.remote}" is not a GitHub repository`);
  }
  const repository = renderGitHubRepository(reference);
  const observedIdentity = yield* github
    .lookupRepositoryIdentity({ repository })
    .pipe(Effect.result);
  if (
    Result.isFailure(observedIdentity) ||
    !githubRepositoriesMatch(observedIdentity.success.repository, repository)
  ) {
    return uncertain(
      `GitHub repository identity could not be confirmed for the configured publication remote "${publication.remote}"`,
    );
  }

  const branch = yield* git
    .readBranch({
      repositoryRoot: configuration.targetRepository,
      branch: taskBranch,
      runId,
    })
    .pipe(Effect.result);
  if (Result.isFailure(branch)) {
    return uncertain(branch.failure.message);
  }
  if (!branch.success.exists || branch.success.commit !== resultCommit) {
    return uncertain(
      `Task branch "${taskBranch}" is not at the approved result commit ${resultCommit}`,
    );
  }
  const commitPresent = yield* git
    .commitExists({
      repositoryRoot: configuration.targetRepository,
      commit: resultCommit,
      runId,
    })
    .pipe(Effect.result);
  if (Result.isFailure(commitPresent)) {
    return uncertain(commitPresent.failure.message);
  }
  if (!commitPresent.success) {
    return uncertain(`The approved result commit ${resultCommit} cannot be resolved`);
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
    return uncertain(remoteSource.failure.message);
  }
  const containsFrozen = yield* readinessGit
    .run(
      ['merge-base', '--is-ancestor', implementation.baseCommit, remoteSource.success.commit],
      configuration.targetRepository,
    )
    .pipe(Effect.result);
  if (Result.isFailure(containsFrozen) || containsFrozen.success.exitCode !== 0) {
    return uncertain(
      `The frozen source commit ${implementation.baseCommit} is no longer contained by remote "${configuration.sourceRemote}/${configuration.sourceBranch}"`,
    );
  }

  const attempt = checkpointsFor(history.derived, resultCommit);
  const hasStage = (stage: PublicationCheckpointStage): boolean =>
    attempt.some((checkpoint) => checkpoint.stage === stage);

  const appendCheckpoint = Effect.fn('publishResultPr.appendCheckpoint')(function* (
    stage: PublicationCheckpointStage,
    url: string | null,
    detail: string,
  ) {
    yield* appendRunEvent({
      runDirectory,
      runId,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'result-pr-checkpoint',
          payload: { stage, url, commit: resultCommit, detail },
        } as const),
    });
  });

  if (!hasStage('pre-push')) {
    yield* appendCheckpoint(
      'pre-push',
      null,
      `verified "${taskBranch}" at ${resultCommit} for ${repository}`,
    );
  }
  if (!hasStage('pushed')) {
    const pushed = yield* github
      .pushTaskBranch({
        repositoryPath: configuration.targetRepository,
        remote: publication.remote,
        taskBranch,
        commit: resultCommit,
        runId,
      })
      .pipe(Effect.result);
    if (Result.isFailure(pushed)) {
      return uncertain(pushed.failure.message);
    }
    yield* appendCheckpoint(
      'pushed',
      null,
      `pushed "${taskBranch}" at ${resultCommit} to "${publication.remote}"`,
    );
  }

  const recordedUrl =
    [...attempt].reverse().find((checkpoint) => checkpoint.stage === 'url-recorded')?.url ?? null;
  let url = recordedUrl;
  if (url === null) {
    const body = renderResultPullRequestBody({
      runId,
      sourceCommit: implementation.baseCommit,
      resultCommit,
      taskBranch,
      criteria: history.derived.acceptedPlan?.criteria ?? [],
    });
    const title = `Approved result for ${runId}`;
    const opened = yield* github
      .openResultPullRequest({
        repository,
        title,
        body,
        headBranch: taskBranch,
        baseBranch: configuration.sourceBranch,
      })
      .pipe(Effect.result);
    if (Result.isFailure(opened)) {
      return uncertain(opened.failure.message);
    }
    if (opened.success.headCommit !== resultCommit) {
      return uncertain(
        `The result pull request points at ${opened.success.headCommit} instead of the approved result commit ${resultCommit}`,
      );
    }
    yield* appendCheckpoint(
      'pull-request-created',
      null,
      `opened ordinary result pull request #${opened.success.number}`,
    );
    url = opened.success.url;
    yield* appendCheckpoint('url-recorded', url, `recorded ${url}`);
  }

  yield* appendRunEvent({
    runDirectory,
    runId,
    createIfMissing: false,
    build: () =>
      Effect.succeed({
        type: 'result-pr-recorded',
        payload: { url, commit: resultCommit, taskBranch },
      } as const),
  });
  return { outcome: 'published', url } as const;
});
