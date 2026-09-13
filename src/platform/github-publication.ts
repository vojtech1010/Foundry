import { spawnSync } from 'node:child_process';
import { Effect, Layer, Schema } from 'effect';

import {
  GitHubPublication,
  GitHubPublicationError,
} from '../application/decision-publication/index.js';

import type {
  GitHubCollaboratorPermission,
  GitHubCreatePullRequestOptions,
  GitHubIssueComment,
  GitHubIssueCommentPage,
  GitHubPullRequest,
  GitHubPullRequestLookup,
  GitHubPullRequestLookupRequest,
  GitHubPushTaskBranchOptions,
  GitHubRefreshPullRequestBodyOptions,
  GitHubRepositoryIdentity,
} from '../application/decision-publication/index.js';

const GITHUB_API_BASE = 'https://api.github.com';

const GITHUB_API_VERSION = '2022-11-28';

const GITHUB_TOKEN_ENVIRONMENT_VARIABLE = 'GITHUB_TOKEN';

const GITHUB_PAGE_SIZE = 100;

function boundCause(cause: unknown): string {
  return String(cause).replaceAll(/\s+/gu, ' ').trim().slice(0, 300);
}

const GitHubRepositorySchema = Schema.Struct({
  full_name: Schema.String,
});

const GitHubPullRequestSchema = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String,
  draft: Schema.Boolean,
  head: Schema.Struct({
    ref: Schema.String,
    sha: Schema.String,
  }),
  base: Schema.Struct({
    ref: Schema.String,
  }),
});

const GitHubPullRequestListSchema = Schema.Array(GitHubPullRequestSchema);

type GitHubPullRequestDocument = (typeof GitHubPullRequestSchema)['Type'];

const GitHubIssueCommentSchema = Schema.Struct({
  id: Schema.Number,
  user: Schema.Struct({
    login: Schema.String,
    type: Schema.String,
  }),
  body: Schema.String,
  created_at: Schema.String,
});

const GitHubIssueCommentListSchema = Schema.Array(GitHubIssueCommentSchema);

const GitHubPermissionSchema = Schema.Struct({
  permission: Schema.String,
});

function failure(operation: string, repository: string, detail: string): GitHubPublicationError {
  return new GitHubPublicationError({
    message: `GitHub publication ${operation} failed for "${repository}": ${detail}`,
    operation,
    repository,
    detail,
  });
}

function githubToken(): string {
  return (process.env[GITHUB_TOKEN_ENVIRONMENT_VARIABLE] ?? '').trim();
}

const requestGitHub = Effect.fn('githubPublication.request')(function* (
  operation: string,
  repository: string,
  path: string,
  init: {
    readonly method: string;
    readonly token: string;
    readonly body?: unknown;
  },
): Effect.fn.Return<{ readonly status: number; readonly body: string }, GitHubPublicationError> {
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${init.token}`,
    'content-type': 'application/json',
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': 'foundry-decision-publication',
  };
  const requestInit: RequestInit = { method: init.method, headers };
  if (init.body !== undefined) {
    requestInit.body = JSON.stringify(init.body);
  }
  const response = yield* Effect.tryPromise({
    try: () => fetch(`${GITHUB_API_BASE}${path}`, requestInit),
    catch: (cause) =>
      failure(operation, repository, `cannot reach the GitHub API: ${boundCause(cause)}`),
  });
  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      failure(operation, repository, `cannot read the GitHub API response: ${boundCause(cause)}`),
  });
  return { status: response.status, body };
});

interface JsonDocumentSchema extends Schema.Constraint {
  readonly DecodingServices: never;
}

const decodeDocument = Effect.fn('githubPublication.decode')(function* <
  DocumentSchema extends JsonDocumentSchema,
>(
  operation: string,
  repository: string,
  documentSchema: DocumentSchema,
  body: string,
  label: string,
): Effect.fn.Return<DocumentSchema['Type'], GitHubPublicationError> {
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(documentSchema))(body).pipe(
    Effect.mapError(() =>
      failure(operation, repository, `GitHub ${label} response was not a recognized document`),
    ),
  );
});

function pullRequestOf(document: GitHubPullRequestDocument): GitHubPullRequest {
  return {
    number: document.number,
    url: document.html_url,
    draft: document.draft,
    headBranch: document.head.ref,
    headCommit: document.head.sha,
    baseBranch: document.base.ref,
  };
}

const lookupRepositoryIdentity = Effect.fn('githubPublication.lookupRepositoryIdentity')(
  function* (options: {
    readonly repository: string;
  }): Effect.fn.Return<GitHubRepositoryIdentity, GitHubPublicationError> {
    const token = githubToken();
    if (token.length === 0) {
      return yield* failure(
        'repository-identity',
        options.repository,
        'GITHUB_TOKEN is not set for the configured publication remote',
      );
    }
    const response = yield* requestGitHub(
      'repository-identity',
      options.repository,
      `/repos/${options.repository}`,
      {
        method: 'GET',
        token,
      },
    );
    if (response.status !== 200) {
      return yield* failure(
        'repository-identity',
        options.repository,
        `repository lookup returned status ${response.status}`,
      );
    }
    const document = yield* decodeDocument(
      'repository-identity',
      options.repository,
      GitHubRepositorySchema,
      response.body,
      'repository',
    );
    return { repository: document.full_name };
  },
);

const classifyLookup = (
  options: GitHubPullRequestLookupRequest,
  documents: ReadonlyArray<GitHubPullRequestDocument>,
): GitHubPullRequestLookup => {
  const matching = documents.filter(
    (document) =>
      document.head.ref === options.headBranch && document.base.ref === options.baseBranch,
  );
  if (matching.length >= GITHUB_PAGE_SIZE) {
    return {
      kind: 'ambiguous',
      detail: 'the open pull request page is saturated and cannot be classified exactly',
    };
  }
  if (matching.length === 0) {
    return { kind: 'absent' };
  }
  const nonDraft = matching.filter((document) => document.draft !== true);
  if (nonDraft.length > 0) {
    return {
      kind: 'ambiguous',
      detail: `open non-draft pull request #${nonDraft[0]?.number ?? 0} matches the task branch`,
    };
  }
  if (matching.length > 1) {
    return {
      kind: 'ambiguous',
      detail: `${matching.length} open draft pull requests match the task branch`,
    };
  }
  const only = matching[0];
  if (only === undefined) {
    return { kind: 'absent' };
  }
  if (only.head.sha !== options.headCommit) {
    return {
      kind: 'ambiguous',
      detail: `open draft pull request #${only.number} points at ${only.head.sha} instead of the recorded result commit ${options.headCommit}`,
    };
  }
  return { kind: 'exact', pullRequest: pullRequestOf(only) };
};

const lookupExactPullRequest = Effect.fn('githubPublication.lookupExactPullRequest')(function* (
  options: GitHubPullRequestLookupRequest,
): Effect.fn.Return<GitHubPullRequestLookup, GitHubPublicationError> {
  const token = githubToken();
  if (token.length === 0) {
    return yield* failure(
      'pull-request-lookup',
      options.repository,
      'GITHUB_TOKEN is not set for the configured publication remote',
    );
  }
  const query = new URLSearchParams({
    state: 'open',
    base: options.baseBranch,
    per_page: String(GITHUB_PAGE_SIZE),
  });
  const response = yield* requestGitHub(
    'pull-request-lookup',
    options.repository,
    `/repos/${options.repository}/pulls?${query.toString()}`,
    { method: 'GET', token },
  );
  if (response.status !== 200) {
    return yield* failure(
      'pull-request-lookup',
      options.repository,
      `pull request lookup returned status ${response.status}`,
    );
  }
  const documents = yield* decodeDocument(
    'pull-request-lookup',
    options.repository,
    GitHubPullRequestListSchema,
    response.body,
    'pull request list',
  );
  return classifyLookup(options, documents);
});

const createDraftPullRequest = Effect.fn('githubPublication.createDraftPullRequest')(function* (
  options: GitHubCreatePullRequestOptions,
): Effect.fn.Return<GitHubPullRequest, GitHubPublicationError> {
  const token = githubToken();
  if (token.length === 0) {
    return yield* failure(
      'draft-pull-request-create',
      options.repository,
      'GITHUB_TOKEN is not set for the configured publication remote',
    );
  }
  const response = yield* requestGitHub(
    'draft-pull-request-create',
    options.repository,
    `/repos/${options.repository}/pulls`,
    {
      method: 'POST',
      token,
      body: {
        title: options.title,
        body: options.body,
        head: options.headBranch,
        base: options.baseBranch,
        draft: true,
      },
    },
  );
  if (response.status !== 201) {
    return yield* failure(
      'draft-pull-request-create',
      options.repository,
      `draft pull request creation returned status ${response.status}`,
    );
  }
  const document = yield* decodeDocument(
    'draft-pull-request-create',
    options.repository,
    GitHubPullRequestSchema,
    response.body,
    'pull request',
  );
  return pullRequestOf(document);
});

const refreshOwnedDraftPullRequestBody = Effect.fn(
  'githubPublication.refreshOwnedDraftPullRequestBody',
)(function* (
  options: GitHubRefreshPullRequestBodyOptions,
): Effect.fn.Return<GitHubPullRequest, GitHubPublicationError> {
  const token = githubToken();
  if (token.length === 0) {
    return yield* failure(
      'draft-pull-request-refresh',
      options.repository,
      'GITHUB_TOKEN is not set for the configured publication remote',
    );
  }
  const response = yield* requestGitHub(
    'draft-pull-request-refresh',
    options.repository,
    `/repos/${options.repository}/pulls/${options.pullRequestNumber}`,
    { method: 'PATCH', token, body: { body: options.body } },
  );
  if (response.status !== 200) {
    return yield* failure(
      'draft-pull-request-refresh',
      options.repository,
      `draft pull request refresh returned status ${response.status}`,
    );
  }
  const document = yield* decodeDocument(
    'draft-pull-request-refresh',
    options.repository,
    GitHubPullRequestSchema,
    response.body,
    'pull request',
  );
  return pullRequestOf(document);
});

const pushTaskBranch = Effect.fn('githubPublication.pushTaskBranch')(function* (
  options: GitHubPushTaskBranchOptions,
): Effect.fn.Return<void, GitHubPublicationError> {
  const repository = options.remote;
  const resolve = yield* Effect.sync(() =>
    spawnSync('git', ['rev-parse', '--verify', `refs/heads/${options.taskBranch}`], {
      cwd: options.repositoryPath,
      encoding: 'utf8',
    }),
  );
  if (resolve.error !== undefined) {
    return yield* failure(
      'task-branch-push',
      repository,
      `cannot inspect the task branch: ${boundCause(resolve.error)}`,
    );
  }
  if (resolve.status !== 0) {
    return yield* failure(
      'task-branch-push',
      repository,
      `task branch "${options.taskBranch}" cannot be resolved in ${options.repositoryPath}`,
    );
  }
  if (resolve.stdout.trim() !== options.commit) {
    return yield* failure(
      'task-branch-push',
      repository,
      `task branch "${options.taskBranch}" is at ${resolve.stdout.trim()} instead of ${options.commit}`,
    );
  }
  const pushed = yield* Effect.sync(() =>
    spawnSync(
      'git',
      [
        'push',
        '--porcelain',
        options.remote,
        `refs/heads/${options.taskBranch}:refs/heads/${options.taskBranch}`,
      ],
      { cwd: options.repositoryPath, encoding: 'utf8' },
    ),
  );
  if (pushed.error !== undefined) {
    return yield* failure(
      'task-branch-push',
      repository,
      `cannot push the task branch: ${boundCause(pushed.error)}`,
    );
  }
  if (pushed.status !== 0) {
    return yield* failure(
      'task-branch-push',
      repository,
      `non-force push of "${options.taskBranch}" failed: ${boundCause(pushed.stderr)}`,
    );
  }
});

const listIssueCommentsAfter = Effect.fn('githubPublication.listIssueCommentsAfter')(
  function* (options: {
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly after: string;
  }): Effect.fn.Return<GitHubIssueCommentPage, GitHubPublicationError> {
    const token = githubToken();
    if (token.length === 0) {
      return yield* failure(
        'issue-comment-lookup',
        options.repository,
        'GITHUB_TOKEN is not set for the configured publication remote',
      );
    }
    const query = new URLSearchParams({ per_page: String(GITHUB_PAGE_SIZE) });
    const response = yield* requestGitHub(
      'issue-comment-lookup',
      options.repository,
      `/repos/${options.repository}/issues/${options.pullRequestNumber}/comments?${query.toString()}`,
      { method: 'GET', token },
    );
    if (response.status !== 200) {
      return yield* failure(
        'issue-comment-lookup',
        options.repository,
        `issue comment lookup returned status ${response.status}`,
      );
    }
    const documents = yield* decodeDocument(
      'issue-comment-lookup',
      options.repository,
      GitHubIssueCommentListSchema,
      response.body,
      'issue comment list',
    );
    const comments: Array<GitHubIssueComment> = [];
    for (const document of documents) {
      if (document.created_at <= options.after) {
        continue;
      }
      comments.push({
        commentId: String(document.id),
        author: document.user.login,
        authorType: document.user.type === 'Bot' ? 'Bot' : 'User',
        body: document.body,
        createdAt: document.created_at,
      });
    }
    return { comments, truncated: documents.length >= GITHUB_PAGE_SIZE };
  },
);

const collaboratorPermission = Effect.fn('githubPublication.collaboratorPermission')(
  function* (options: {
    readonly repository: string;
    readonly username: string;
  }): Effect.fn.Return<GitHubCollaboratorPermission, GitHubPublicationError> {
    const token = githubToken();
    if (token.length === 0) {
      return yield* failure(
        'collaborator-permission',
        options.repository,
        'GITHUB_TOKEN is not set for the configured publication remote',
      );
    }
    const response = yield* requestGitHub(
      'collaborator-permission',
      options.repository,
      `/repos/${options.repository}/collaborators/${encodeURIComponent(options.username)}/permission`,
      { method: 'GET', token },
    );
    if (response.status !== 200) {
      return yield* failure(
        'collaborator-permission',
        options.repository,
        `collaborator permission lookup returned status ${response.status}`,
      );
    }
    const document = yield* decodeDocument(
      'collaborator-permission',
      options.repository,
      GitHubPermissionSchema,
      response.body,
      'collaborator permission',
    );
    return { permission: document.permission };
  },
);

export const GitHubPublicationLive: Layer.Layer<GitHubPublication> = Layer.succeed(
  GitHubPublication,
  GitHubPublication.of({
    lookupRepositoryIdentity,
    lookupExactPullRequest,
    createDraftPullRequest,
    refreshOwnedDraftPullRequestBody,
    pushTaskBranch,
    listIssueCommentsAfter,
    collaboratorPermission,
  }),
);
