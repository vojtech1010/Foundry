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

import type {
  ProjectConfiguration,
  ResultPublicationMode,
} from '../../domain/project-configuration.js';
import type {
  ResultPublicationCheckpointStage,
  RunEvent,
  RunHistoryDerivedState,
} from '../../domain/run-history.js';
import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';

/**
 * The outcome of publishing the ordinary result for an approved changed result.
 * `published` names the exact result pull request URL; `merged` records that the
 * accepted commit was taken forward by updating the configured source branch;
 * `skipped` means the run legitimately completed without a remote result
 * (publication not configured or not eligible, no changed result, or no ordinary
 * approval); `uncertain` means the transaction could not be settled safely, and
 * the same run must be resumed so the journal and remote can be reconciled in
 * place.
 */
export type ResultPublicationReport =
  | { readonly outcome: 'published'; readonly url: string }
  | {
      readonly outcome: 'merged';
      readonly commit: string;
      readonly sourceBranch: string;
      readonly fastForward: boolean;
    }
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
  readonly mode: ResultPublicationMode;
  readonly sourceCommit: string;
  readonly resultCommit: string;
  readonly taskBranch: string;
  readonly criteria: ReadonlyArray<{ readonly id: string; readonly text: string }>;
}

/**
 * Renders the ordinary result pull request body for the configured publication
 * mode. It presents the approved result and the exact accepted commit for the
 * team's normal GitHub process; it is never a request for human judgment and
 * carries no authenticated Foundry command. The taking-forward text states what
 * the mode does with the result instead of a blanket no-merge claim.
 */
export function renderResultPullRequestBody(input: ResultPullRequestBodyInput): string {
  const lines = [
    `# Approved result for ${input.runId}`,
    '',
    'Foundry completed this run and prepared the exact approved result for this',
    'publication mode. This is the team result surface; it is not a request for',
    'human judgment and it does not itself mean the work is merged.',
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
  lines.push('## Taking this result forward', '');
  if (input.mode === 'direct-merge') {
    lines.push('Foundry updated the configured source branch to the accepted result commit.', '');
  } else if (input.mode === 'non-draft-pr-auto-merge') {
    lines.push(
      "Review this pull request through the team's normal GitHub process.",
      'GitHub may merge this pull request automatically once required checks pass.',
      '',
    );
  } else {
    lines.push(
      "Review and merge this pull request through the team's normal GitHub process.",
      'Foundry never merges a result pull request itself; the merge stays the',
      "team's action.",
      '',
    );
  }
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

/**
 * Reads the numeric pull request id from a recorded GitHub pull request URL so a
 * resumed auto-merge enablement can target the surviving pull request without a
 * second lookup. A URL that does not end in a pull request number is refused by
 * the caller as uncertain rather than guessed.
 */
function pullRequestNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)\/?$/u.exec(url);
  if (match === null) {
    return null;
  }
  return Number.parseInt(match[1] ?? '', 10);
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

  const mode = configuration.resultPublication.mode;
  const mergeMethod = configuration.resultPublication.mergeMethod;
  const attempt = checkpointsFor(history.derived, resultCommit);
  const hasStage = (stage: ResultPublicationCheckpointStage): boolean =>
    attempt.some((checkpoint) => checkpoint.stage === stage);

  const appendCheckpoint = Effect.fn('publishResultPr.appendCheckpoint')(function* (
    stage: ResultPublicationCheckpointStage,
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

  const recordResultMerge = Effect.fn('publishResultPr.recordResultMerge')(function* (
    fastForward: boolean,
  ) {
    yield* appendRunEvent({
      runDirectory,
      runId,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'result-merge-recorded',
          payload: {
            commit: resultCommit,
            taskBranch,
            remote: publication.remote,
            sourceBranch: configuration.sourceBranch,
            fastForward,
          },
        } as const),
    });
  });

  if (mode === 'direct-merge') {
    const settled = history.derived.resultMergeRecorded ?? null;
    if (settled !== null && settled.commit === resultCommit) {
      return {
        outcome: 'merged',
        commit: resultCommit,
        sourceBranch: configuration.sourceBranch,
        fastForward: settled.fastForward,
      } as const;
    }
    if (hasStage('source-branch-updated')) {
      const observed = remoteSource.success.commit;
      if (observed === resultCommit) {
        yield* recordResultMerge(true);
        return {
          outcome: 'merged',
          commit: resultCommit,
          sourceBranch: configuration.sourceBranch,
          fastForward: true,
        } as const;
      }
      return uncertain(
        `Source branch "${configuration.sourceBranch}" is at ${observed} instead of the accepted result commit ${resultCommit}`,
      );
    }
    if (!hasStage('pre-push')) {
      yield* appendCheckpoint(
        'pre-push',
        null,
        `verified "${taskBranch}" at ${resultCommit} for ${repository}`,
      );
    }
    const ancestor = yield* readinessGit
      .run(
        ['merge-base', '--is-ancestor', remoteSource.success.commit, resultCommit],
        configuration.targetRepository,
      )
      .pipe(Effect.result);
    const fastForward = Result.isSuccess(ancestor) && ancestor.success.exitCode === 0;
    const pushed = yield* github
      .pushSourceBranch({
        repositoryPath: configuration.targetRepository,
        remote: publication.remote,
        sourceBranch: configuration.sourceBranch,
        commit: resultCommit,
        expectedRemoteCommit: remoteSource.success.commit,
        runId,
      })
      .pipe(Effect.result);
    if (Result.isFailure(pushed)) {
      return uncertain(pushed.failure.message);
    }
    yield* appendCheckpoint(
      'source-branch-updated',
      null,
      `updated "${configuration.sourceBranch}" to ${resultCommit} on "${publication.remote}"`,
    );
    yield* recordResultMerge(fastForward);
    return {
      outcome: 'merged',
      commit: resultCommit,
      sourceBranch: configuration.sourceBranch,
      fastForward,
    } as const;
  }

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
      mode,
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
        draft: mode === 'draft-pr',
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
      `opened ${mode === 'draft-pr' ? 'draft' : 'ordinary'} result pull request #${opened.success.number}`,
    );
    url = opened.success.url;
    yield* appendCheckpoint('url-recorded', url, `recorded ${url}`);
  }

  if (mode === 'non-draft-pr-auto-merge' && !hasStage('auto-merge-enabled')) {
    const pullRequestNumber = pullRequestNumberFromUrl(url);
    if (pullRequestNumber === null) {
      return uncertain(`Cannot determine the result pull request number from ${url}`);
    }
    const enabled = yield* github
      .enablePullRequestAutoMerge({
        repository,
        pullRequestNumber,
        mergeMethod,
      })
      .pipe(Effect.result);
    if (Result.isFailure(enabled)) {
      return uncertain(enabled.failure.message);
    }
    yield* appendCheckpoint(
      'auto-merge-enabled',
      null,
      `enabled ${mergeMethod} auto-merge on pull request #${pullRequestNumber}`,
    );
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
