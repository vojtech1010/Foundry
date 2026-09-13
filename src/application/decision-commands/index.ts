import { Effect, Result } from 'effect';
import { createHash } from 'node:crypto';

import { exactDecisionCommands } from '../../domain/decision-publication.js';
import { parseGitHubRepositoryRemote, renderGitHubRepository } from '../../domain/readiness.js';

import { GitHubPublication } from '../decision-publication/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';
import { transitionWorkflow } from '../workflow-transitions/index.js';

import type { DecisionOpenedOption } from '../../domain/decision-publication.js';
import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type { DecisionPermissionSnapshot } from '../../domain/run-history.js';
import type { RunEvent } from '../../domain/run-history.js';
import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';
import type { IllegalWorkflowTransition } from '../workflow-transitions/index.js';
import type { RunStateUnavailable } from '../run-identity/index.js';
import type { RunGit, RunWorkspaceBlocked } from '../git-provisioning/index.js';

/**
 * Provenance for one authenticated decision command. The comment body is never
 * stored; the hash plus the comment id, author, and permission snapshot make a
 * later edit or deletion unable to undo the recorded choice.
 */
export interface DecisionCommentEvidence {
  readonly commentId: string;
  readonly author: string;
  readonly bodyHash: string;
  readonly permissionSnapshot: DecisionPermissionSnapshot;
}

/**
 * The result of scanning the owned decision pull request for one exact
 * authenticated command. `waiting` and `applied` are safe outcomes; the other
 * kinds are integrity stops where Foundry refuses to guess and reports the
 * problem instead of changing state.
 */
export type DecisionScanOutcome =
  | { readonly kind: 'waiting'; readonly draftPrUrl: string | null }
  | {
      readonly kind: 'applied';
      readonly decisionId: string;
      readonly option: DecisionOpenedOption;
      readonly evidence: DecisionCommentEvidence;
      readonly draftPrUrl: string | null;
    }
  | {
      readonly kind: 'conflict' | 'unverifiable' | 'changed' | 'ambiguous';
      readonly problem: string;
      readonly draftPrUrl: string | null;
    };

export interface ScanForDecisionOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly configuration: ProjectConfiguration;
}

export type ScanForDecisionError = RunHistoryError;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function latestOpenedDecision(
  events: ReadonlyArray<RunEvent>,
): Extract<RunEvent, { readonly type: 'decision-opened' }>['payload'] | null {
  let found: Extract<RunEvent, { readonly type: 'decision-opened' }>['payload'] | null = null;
  for (const event of events) {
    if (event.type === 'decision-opened') {
      found = event.payload;
    }
  }
  return found;
}

function latestUrlCheckpoint(
  events: ReadonlyArray<RunEvent>,
  decisionId: string,
): Extract<RunEvent, { readonly type: 'publication-checkpoint' }> | null {
  let found: Extract<RunEvent, { readonly type: 'publication-checkpoint' }> | null = null;
  for (const event of events) {
    if (
      event.type === 'publication-checkpoint' &&
      event.payload.stage === 'url-recorded' &&
      event.payload.decisionId === decisionId
    ) {
      found = event;
    }
  }
  return found;
}

/**
 * Reads the decision pull request opened by `publishDecisionDraftPr` and
 * decides whether exactly one exact authenticated command selects an option.
 * Only comments created after the run's last publication checkpoint are
 * considered, the author must be a human whose current repository permission is
 * `maintain` or `admin`, the pull request must still be the recorded open
 * draft, and its head must be the recorded result commit. Every other outcome
 * is reported, never guessed.
 */
export const scanForDecision = Effect.fn('scanForDecision')(function* (
  options: ScanForDecisionOptions,
): Effect.fn.Return<
  DecisionScanOutcome,
  ScanForDecisionError,
  GitHubPublication | RunHistoryStorage
> {
  const { runDirectory, runId, configuration } = options;
  const github = yield* GitHubPublication;
  const history = yield* readVerifiedRunHistory({ runDirectory, runId, createIfMissing: false });
  const events = history.events;

  const opened = latestOpenedDecision(events);
  if (opened === null) {
    return {
      kind: 'unverifiable',
      problem: 'the run is awaiting a decision but no decision-opened record exists',
      draftPrUrl: null,
    } satisfies DecisionScanOutcome;
  }
  const sourceFrozen = history.derived.sourceFrozen;
  const implementation = history.derived.implementation;
  if (sourceFrozen === null || implementation === null) {
    return {
      kind: 'unverifiable',
      problem: 'the decision cannot be verified without a frozen source and result commit',
      draftPrUrl: null,
    } satisfies DecisionScanOutcome;
  }
  const resultCommit = implementation.commit ?? implementation.baseCommit;
  if (opened.resultCommit !== resultCommit) {
    return {
      kind: 'changed',
      problem: `the open decision names result commit ${opened.resultCommit} instead of the current result head ${resultCommit}`,
      draftPrUrl: null,
    } satisfies DecisionScanOutcome;
  }
  const checkpoint = latestUrlCheckpoint(events, opened.decisionId);
  if (checkpoint === null || checkpoint.payload.draftPrUrl === null) {
    return {
      kind: 'unverifiable',
      problem: 'no recorded draft pull request URL exists for the open decision',
      draftPrUrl: null,
    } satisfies DecisionScanOutcome;
  }
  const draftPrUrl = checkpoint.payload.draftPrUrl;

  const recorded = events.find(
    (event) => event.type === 'decision-applied' && event.payload.decisionId === opened.decisionId,
  );
  if (recorded !== undefined && recorded.type === 'decision-applied') {
    const option = opened.options.find((candidate) => candidate.id === recorded.payload.optionId);
    if (option === undefined) {
      return {
        kind: 'unverifiable',
        problem: `the recorded decision references an unknown option ${recorded.payload.optionId}`,
        draftPrUrl,
      } satisfies DecisionScanOutcome;
    }
    return {
      kind: 'applied',
      decisionId: opened.decisionId,
      option,
      evidence: {
        commentId: recorded.payload.commentId,
        author: recorded.payload.author,
        bodyHash: recorded.payload.bodyHash,
        permissionSnapshot: recorded.payload.permissionSnapshot,
      },
      draftPrUrl,
    } satisfies DecisionScanOutcome;
  }

  const remote = parseGitHubRepositoryRemote(sourceFrozen.repository.remoteUrl);
  if (remote === undefined) {
    return {
      kind: 'unverifiable',
      problem: `the publication remote "${sourceFrozen.repository.remoteUrl}" is not a GitHub repository`,
      draftPrUrl,
    } satisfies DecisionScanOutcome;
  }
  const repository = renderGitHubRepository(remote);

  const lookup = yield* github
    .lookupExactPullRequest({
      repository,
      headBranch: implementation.taskBranch,
      headCommit: resultCommit,
      baseBranch: configuration.sourceBranch,
    })
    .pipe(Effect.result);
  if (Result.isFailure(lookup)) {
    return {
      kind: 'changed',
      problem: `the decision pull request could not be verified: ${lookup.failure.message}`,
      draftPrUrl,
    } satisfies DecisionScanOutcome;
  }
  if (lookup.success.kind === 'absent') {
    return {
      kind: 'changed',
      problem: 'the recorded decision pull request is no longer an open draft',
      draftPrUrl,
    } satisfies DecisionScanOutcome;
  }
  if (lookup.success.kind === 'ambiguous') {
    return {
      kind: 'changed',
      problem: lookup.success.detail,
      draftPrUrl,
    } satisfies DecisionScanOutcome;
  }
  const pullRequest = lookup.success.pullRequest;
  if (pullRequest.url !== draftPrUrl) {
    return {
      kind: 'changed',
      problem: `open pull request ${pullRequest.url} is not the recorded decision pull request ${draftPrUrl}`,
      draftPrUrl,
    } satisfies DecisionScanOutcome;
  }

  const page = yield* github
    .listIssueCommentsAfter({
      repository,
      pullRequestNumber: pullRequest.number,
      after: checkpoint.occurredAt,
    })
    .pipe(Effect.result);
  if (Result.isFailure(page)) {
    return {
      kind: 'unverifiable',
      problem: `the decision comments could not be read: ${page.failure.message}`,
      draftPrUrl,
    } satisfies DecisionScanOutcome;
  }
  if (page.success.truncated) {
    return {
      kind: 'ambiguous',
      problem: 'the decision comment page could not be proven complete',
      draftPrUrl,
    } satisfies DecisionScanOutcome;
  }

  const commands = exactDecisionCommands({
    runId,
    decisionId: opened.decisionId,
    nonce: opened.nonce,
    options: opened.options,
  });
  const optionByCommand = new Map<string, DecisionOpenedOption>();
  for (const [index, command] of commands.entries()) {
    const option = opened.options[index];
    if (option !== undefined) {
      optionByCommand.set(command, option);
    }
  }

  const selected = new Map<
    string,
    { readonly option: DecisionOpenedOption; readonly evidence: DecisionCommentEvidence }
  >();
  for (const comment of page.success.comments) {
    const option = optionByCommand.get(comment.body.trim());
    if (option === undefined || selected.has(option.id) || comment.authorType !== 'User') {
      continue;
    }
    const permission = yield* github
      .collaboratorPermission({ repository, username: comment.author })
      .pipe(Effect.result);
    if (Result.isFailure(permission)) {
      return {
        kind: 'unverifiable',
        problem: `the permission of decision author "${comment.author}" could not be verified: ${permission.failure.message}`,
        draftPrUrl,
      } satisfies DecisionScanOutcome;
    }
    if (permission.success.permission !== 'admin' && permission.success.permission !== 'maintain') {
      continue;
    }
    selected.set(option.id, {
      option,
      evidence: {
        commentId: comment.commentId,
        author: comment.author,
        bodyHash: sha256Hex(comment.body.trim()),
        permissionSnapshot: permission.success.permission,
      },
    });
  }

  if (selected.size === 0) {
    return { kind: 'waiting', draftPrUrl } satisfies DecisionScanOutcome;
  }
  if (selected.size > 1) {
    return {
      kind: 'conflict',
      problem: 'conflicting valid decision options were recorded for the same decision',
      draftPrUrl,
    } satisfies DecisionScanOutcome;
  }
  const only = [...selected.values()][0];
  if (only === undefined) {
    return { kind: 'waiting', draftPrUrl } satisfies DecisionScanOutcome;
  }
  return {
    kind: 'applied',
    decisionId: opened.decisionId,
    option: only.option,
    evidence: only.evidence,
    draftPrUrl,
  } satisfies DecisionScanOutcome;
});

/**
 * A decision id is applied at most once. The event is appended before the
 * workflow transition so the durable decision survives an interrupted resume;
 * the transition is then re-driven without a duplicate event.
 */
export interface AppliedDecision {
  readonly decisionId: string;
  readonly option: DecisionOpenedOption;
  readonly evidence: DecisionCommentEvidence;
}

export interface ApplyDecisionOptions {
  readonly runDirectory: string;
  readonly runId: string;
}

export type ApplyDecisionError =
  | RunHistoryError
  | IllegalWorkflowTransition
  | RunStateUnavailable
  | RunWorkspaceBlocked;

/**
 * Durably records the authenticated decision and routes it. `accept` completes
 * locally, `correct` returns to the Coder once without spending an automatic
 * correction round, and `abandon` ends the run as abandoned with the decision
 * evidence as its recorded reason.
 */
export const applyDecision = Effect.fn('applyDecision')(function* (
  options: ApplyDecisionOptions,
  applied: AppliedDecision,
): Effect.fn.Return<void, ApplyDecisionError, RunHistoryStorage | RunGit> {
  const { runDirectory, runId } = options;
  const history = yield* readVerifiedRunHistory({ runDirectory, runId, createIfMissing: false });
  const alreadyApplied = history.events.some(
    (event) => event.type === 'decision-applied' && event.payload.decisionId === applied.decisionId,
  );
  if (!alreadyApplied) {
    yield* appendRunEvent({
      runDirectory,
      runId,
      createIfMissing: false,
      build: () =>
        Effect.succeed({
          type: 'decision-applied',
          payload: {
            decisionId: applied.decisionId,
            optionId: applied.option.id,
            action: applied.option.action,
            commentId: applied.evidence.commentId,
            author: applied.evidence.author,
            bodyHash: applied.evidence.bodyHash,
            permissionSnapshot: applied.evidence.permissionSnapshot,
          },
        } as const),
    });
  }
  switch (applied.option.action) {
    case 'accept':
      yield* transitionWorkflow({
        runDirectory,
        runId,
        request: { route: 'human-accepted', authenticated: true },
      });
      return;
    case 'correct':
      yield* transitionWorkflow({
        runDirectory,
        runId,
        request: { route: 'human-corrected', authenticated: true },
      });
      return;
    case 'abandon':
      yield* transitionWorkflow({
        runDirectory,
        runId,
        request: {
          route: 'abandon-run',
          explicitRequest: true,
          reason: `Authenticated decision ${applied.decisionId} selected option ${applied.option.id} (${applied.option.label}) from comment ${applied.evidence.commentId} by ${applied.evidence.author}.`,
        },
      });
      return;
  }
});
