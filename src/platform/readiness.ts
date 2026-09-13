import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync, statSync } from 'node:fs';

import { Effect, Layer, Result, Schema } from 'effect';

import {
  PublicationProbe,
  PublicationProbeError,
  ReadinessError,
  ReadinessFiles,
  ReadinessGit,
  ReadinessHost,
} from '../application/readiness/index.js';

import type {
  PublicationCollaboratorPermission,
  PublicationProbeObservation,
  PublicationProbeRequest,
} from '../application/readiness/index.js';

function boundCause(cause: unknown): string {
  return String(cause).replaceAll(/\s+/gu, ' ').trim().slice(0, 200);
}

const runVersionTool = Effect.fn('runVersionTool')(function* (
  command: string,
  args: ReadonlyArray<string>,
  label: string,
  expected: string,
): Effect.fn.Return<string, ReadinessError> {
  const result = yield* Effect.sync(() => spawnSync(command, [...args], { encoding: 'utf8' }));
  if (result.error !== undefined) {
    return yield* new ReadinessError({
      message: `Missing required tool: ${label}. Expected ${expected}.`,
    });
  }
  if (result.status !== 0) {
    return yield* new ReadinessError({
      message: `Cannot determine ${label} version: ${boundCause(result.stdout)}. Expected ${expected}.`,
    });
  }
  return result.stdout;
});

const readConfigFile = Effect.fn('readConfigFile')(function* (
  path: string,
): Effect.fn.Return<string, ReadinessError> {
  return yield* Effect.try({
    try: () => readFileSync(path, 'utf8'),
    catch: (cause) =>
      new ReadinessError({
        message: `Cannot read configuration document at ${path}: ${boundCause(cause)}.`,
      }),
  });
});

const statConfiguredPath = Effect.fn('statConfiguredPath')(function* (
  path: string,
): Effect.fn.Return<{ readonly exists: boolean; readonly isDirectory: boolean }, ReadinessError> {
  const probed = yield* Effect.try({
    try: () => statSync(path),
    catch: (_cause) => 'unavailable' as const,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (probed === undefined) {
    return { exists: false, isDirectory: false };
  }
  return { exists: true, isDirectory: probed.isDirectory() };
});

const checkWritable = Effect.fn('checkWritable')(function* (
  path: string,
): Effect.fn.Return<boolean, ReadinessError> {
  const probed = yield* Effect.try({
    try: () => {
      accessSync(path, constants.W_OK);
      return true;
    },
    catch: (_cause) => 'unavailable' as const,
  }).pipe(Effect.orElseSucceed(() => false));
  return probed;
});

const runGitCommand = Effect.fn('runGitCommand')(function* (
  args: ReadonlyArray<string>,
  cwd: string,
): Effect.fn.Return<{ readonly stdout: string; readonly exitCode: number }, ReadinessError> {
  const result = yield* Effect.sync(() => spawnSync('git', [...args], { cwd, encoding: 'utf8' }));
  if (result.error !== undefined) {
    return yield* new ReadinessError({
      message: `Cannot run Git in ${cwd}: ${boundCause(result.error)}.`,
    });
  }
  return { stdout: result.stdout, exitCode: result.status ?? 1 };
});

const GITHUB_API_BASE = 'https://api.github.com';

const GITHUB_API_VERSION = '2022-11-28';

const GITHUB_TOKEN_ENVIRONMENT_VARIABLE = 'GITHUB_TOKEN';

interface JsonDocumentSchema extends Schema.Constraint {
  readonly DecodingServices: never;
}

const GitHubRepositorySchema = Schema.Struct({
  full_name: Schema.String,
  permissions: Schema.optional(
    Schema.Struct({
      push: Schema.optional(Schema.Boolean),
    }),
  ),
});

const GitHubViewerSchema = Schema.Struct({
  login: Schema.String,
});

const GitHubCollaboratorPermissionSchema = Schema.Struct({
  permission: Schema.Literals(['admin', 'maintain', 'write', 'triage', 'read', 'none']),
});

const GitHubProtectedBranchSchema = Schema.Array(
  Schema.Struct({
    name: Schema.String,
  }),
);

interface GitHubHttpResponse {
  readonly status: number;
  readonly scopes: ReadonlyArray<string> | null;
  readonly body: string;
}

function parseGitHubScopes(header: string | null): ReadonlyArray<string> | null {
  if (header === null) {
    return null;
  }
  return header
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

const decodeGitHubDocument = Effect.fn('publicationProbe.decodeDocument')(function* <
  DocumentSchema extends JsonDocumentSchema,
>(
  schema: DocumentSchema,
  body: string,
  label: string,
): Effect.fn.Return<DocumentSchema['Type'], PublicationProbeError> {
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body).pipe(
    Effect.mapError(
      () =>
        new PublicationProbeError({
          message: `GitHub ${label} response was not a recognized document.`,
        }),
    ),
  );
});

const requestGitHub = Effect.fn('publicationProbe.requestGitHub')(function* (
  path: string,
  token: string,
): Effect.fn.Return<GitHubHttpResponse, PublicationProbeError> {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(`${GITHUB_API_BASE}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': GITHUB_API_VERSION,
          'user-agent': 'foundry-publication-readiness',
        },
      }),
    catch: (cause) =>
      new PublicationProbeError({
        message: `Cannot reach the GitHub API: ${boundCause(cause)}.`,
      }),
  });
  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) =>
      new PublicationProbeError({
        message: `Cannot read the GitHub API response: ${boundCause(cause)}.`,
      }),
  });
  return {
    status: response.status,
    scopes: parseGitHubScopes(response.headers.get('x-oauth-scopes')),
    body,
  };
});

const observePublication = Effect.fn('publicationProbe.observe')(function* (
  request: PublicationProbeRequest,
): Effect.fn.Return<PublicationProbeObservation, PublicationProbeError> {
  const token = (process.env[GITHUB_TOKEN_ENVIRONMENT_VARIABLE] ?? '').trim();
  if (token.length === 0) {
    return {
      repository: request.repository,
      tokenPresent: false,
      push: false,
      collaboratorPermission: null,
      issueCommentReadable: null,
      tokenScopes: null,
      protectedBranches: null,
      limitations: [],
    };
  }
  const lookup = yield* requestGitHub(`/repos/${request.repository}`, token);
  if (lookup.status !== 200) {
    return {
      repository: request.repository,
      tokenPresent: true,
      push: false,
      collaboratorPermission: null,
      issueCommentReadable: null,
      tokenScopes: lookup.scopes,
      protectedBranches: null,
      limitations: [`GitHub repository lookup failed with status ${lookup.status}.`],
    };
  }
  const repository = yield* decodeGitHubDocument(GitHubRepositorySchema, lookup.body, 'repository');
  const limitations: Array<string> = [];

  const viewer = yield* requestGitHub('/user', token);
  let collaboratorPermission: PublicationCollaboratorPermission | null = null;
  if (viewer.status === 200) {
    const account = yield* decodeGitHubDocument(GitHubViewerSchema, viewer.body, 'viewer');
    const permission = yield* requestGitHub(
      `/repos/${request.repository}/collaborators/${encodeURIComponent(account.login)}/permission`,
      token,
    );
    if (permission.status === 200) {
      const decoded = yield* decodeGitHubDocument(
        GitHubCollaboratorPermissionSchema,
        permission.body,
        'collaborator permission',
      );
      collaboratorPermission = decoded.permission;
    } else {
      limitations.push(`Collaborator permission lookup failed with status ${permission.status}.`);
    }
  } else {
    limitations.push(`GitHub viewer lookup failed with status ${viewer.status}.`);
  }

  const comments = yield* requestGitHub(
    `/repos/${request.repository}/issues/comments?per_page=1`,
    token,
  );
  let issueCommentReadable: boolean | null = null;
  if (comments.status === 200) {
    issueCommentReadable = true;
  } else {
    issueCommentReadable = [401, 403, 404].includes(comments.status) ? false : null;
    limitations.push(`Issue comment read failed with status ${comments.status}.`);
  }

  let protectedBranches: ReadonlyArray<string> | null = null;
  const protectedList = yield* requestGitHub(
    `/repos/${request.repository}/branches?protected=true&per_page=100`,
    token,
  );
  if (protectedList.status === 200) {
    const decoded = yield* decodeGitHubDocument(
      GitHubProtectedBranchSchema,
      protectedList.body,
      'protected branches',
    ).pipe(Effect.result);
    if (Result.isSuccess(decoded)) {
      protectedBranches =
        decoded.success.length >= 100 ? null : decoded.success.map((branch) => branch.name);
    }
  }

  return {
    repository: repository.full_name,
    tokenPresent: true,
    push: repository.permissions?.push ?? false,
    collaboratorPermission,
    issueCommentReadable,
    tokenScopes: lookup.scopes,
    protectedBranches,
    limitations,
  };
});

export const PublicationProbeLive: Layer.Layer<PublicationProbe> = Layer.succeed(
  PublicationProbe,
  PublicationProbe.of({ observe: observePublication }),
);

export const ReadinessHostLive: Layer.Layer<ReadinessHost> = Layer.succeed(
  ReadinessHost,
  ReadinessHost.of({
    platform: Effect.sync(() => process.platform),
    nodeVersion: runVersionTool(process.execPath, ['--version'], 'Node.js', '24.14.0'),
    npmVersion: runVersionTool('npm', ['--version'], 'npm', '11.9.0'),
    gitVersionOutput: runVersionTool('git', ['version'], 'Git', '2.43 or newer'),
  }),
);

export const ReadinessFilesLive: Layer.Layer<ReadinessFiles> = Layer.succeed(
  ReadinessFiles,
  ReadinessFiles.of({
    readFile: (path: string) => readConfigFile(path),
    statPath: (path: string) => statConfiguredPath(path),
    isWritable: (path: string) => checkWritable(path),
  }),
);

export const ReadinessGitLive: Layer.Layer<ReadinessGit> = Layer.succeed(
  ReadinessGit,
  ReadinessGit.of({
    run: (args: ReadonlyArray<string>, cwd: string) => runGitCommand(args, cwd),
  }),
);

export const ReadinessLive = Layer.mergeAll(
  ReadinessHostLive,
  ReadinessFilesLive,
  ReadinessGitLive,
  PublicationProbeLive,
);
