import { Context, Effect, Option, Result, Schema } from 'effect';
import { dirname, join, resolve } from 'node:path';

import {
  GIT_OPERATION_MARKERS,
  PUBLICATION_CAPABILITIES,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_VERSION,
  RUN_STORAGE_DIRECTORY_NAME,
  displayPlatform,
  extractGitVersionNumber,
  githubRepositoriesMatch,
  isSupportedGitVersion,
  isSupportedPlatform,
  normalizeToolVersion,
  parseGitHubRepositoryRemote,
  parseGitVersion,
  publicationRepositoryScope,
  renderGitHubRepository,
} from '../../domain/readiness.js';
import { BRANCH_PROTECTION_NOT_CONFIGURED } from '../../domain/run-locations.js';

import { invalidRedactionPatterns } from '../evidence-limits/index.js';
import { decodeProjectConfiguration } from '../project-configuration.js';
import { preflightRoleHostCapabilities } from '../role-conversations/index.js';

import type {
  PublicationCapability,
  PublicationCapabilityState,
  PublicationRepositoryScope,
} from '../../domain/readiness.js';
import type { DecisionPublicationConfiguration } from '../../domain/project-configuration.js';
import type { BranchProtectionEvidence } from '../../domain/run-locations.js';
import type { RoleHostCapabilityError, RoleHostLauncher } from '../role-conversations/index.js';

export class ReadinessError extends Schema.TaggedError<ReadinessError>()('ReadinessError', {
  message: Schema.String,
}) {}

export interface GitCommandResult {
  readonly stdout: string;
  readonly exitCode: number;
}

export interface PathStatus {
  readonly exists: boolean;
  readonly isDirectory: boolean;
}

export class ReadinessHost extends Context.Service<
  ReadinessHost,
  {
    readonly platform: Effect.Effect<string>;
    readonly nodeVersion: Effect.Effect<string, ReadinessError>;
    readonly npmVersion: Effect.Effect<string, ReadinessError>;
    readonly gitVersionOutput: Effect.Effect<string, ReadinessError>;
  }
>()('foundry/application/readiness/Host') {}

export class ReadinessFiles extends Context.Service<
  ReadinessFiles,
  {
    readonly readFile: (path: string) => Effect.Effect<string, ReadinessError>;
    readonly statPath: (path: string) => Effect.Effect<PathStatus, ReadinessError>;
    readonly isWritable: (path: string) => Effect.Effect<boolean, ReadinessError>;
  }
>()('foundry/application/readiness/Files') {}

export class ReadinessGit extends Context.Service<
  ReadinessGit,
  {
    readonly run: (
      args: ReadonlyArray<string>,
      cwd: string,
    ) => Effect.Effect<GitCommandResult, ReadinessError>;
  }
>()('foundry/application/readiness/Git') {}

export type PublicationCollaboratorPermission =
  | 'admin'
  | 'maintain'
  | 'write'
  | 'triage'
  | 'read'
  | 'none';

export interface PublicationProbeRequest {
  readonly repository: string;
}

/**
 * Bounded, non-mutating observation of GitHub publication capability. Every
 * nullable field is `null` when the probe could not establish the fact, which
 * keeps unverified privilege absence out of the readiness classification.
 */
export interface PublicationProbeObservation {
  readonly repository: string;
  readonly tokenPresent: boolean;
  readonly push: boolean;
  readonly collaboratorPermission: PublicationCollaboratorPermission | null;
  readonly issueCommentReadable: boolean | null;
  readonly tokenScopes: ReadonlyArray<string> | null;
  readonly protectedBranches: ReadonlyArray<string> | null;
  readonly limitations: ReadonlyArray<string>;
}

export class PublicationProbeError extends Schema.TaggedError<PublicationProbeError>()(
  'PublicationProbeError',
  {
    message: Schema.String,
  },
) {}

export class PublicationProbe extends Context.Service<
  PublicationProbe,
  {
    readonly observe: (
      request: PublicationProbeRequest,
    ) => Effect.Effect<PublicationProbeObservation, PublicationProbeError>;
  }
>()('foundry/application/readiness/PublicationProbe') {}

export interface DoctorHostReport {
  readonly platform: string;
  readonly nodeVersion: string;
  readonly npmVersion: string;
  readonly gitVersion: string;
}

export interface DoctorConfigReport {
  readonly path: string;
  readonly schemaVersion: number;
}

export interface DoctorStorageReport {
  readonly path: string;
  readonly ignored: true;
}

export interface DoctorRepositoryReport {
  readonly path: string;
  readonly remote: string;
  readonly branch: string;
  readonly commit: string;
}

export interface DoctorRoleHostReport {
  readonly protocol: string;
  readonly adapterVersion: string;
  readonly resumable: true;
  readonly availableRoles: ReadonlyArray<string>;
  readonly filesystemProfiles: ReadonlyArray<string>;
  readonly networkProfiles: ReadonlyArray<string>;
}

export interface DoctorPublicationCapabilityReport {
  readonly capability: PublicationCapability;
  readonly state: PublicationCapabilityState;
}

export interface DoctorPublicationReport {
  readonly configured: boolean;
  readonly eligible: boolean;
  readonly remote: string | null;
  readonly repository: string | null;
  readonly repositoryScope: PublicationRepositoryScope;
  readonly reason: string | null;
  readonly capabilities: ReadonlyArray<DoctorPublicationCapabilityReport>;
}

export interface DoctorReport {
  readonly host: DoctorHostReport;
  readonly config: DoctorConfigReport;
  readonly storage: DoctorStorageReport;
  readonly repository: DoctorRepositoryReport;
  readonly roleHost: DoctorRoleHostReport;
  readonly publication: DoctorPublicationReport;
}

export interface CheckReadinessOptions {
  readonly configArg: string;
  readonly cwd: string;
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

function firstReachableCommit(output: string): string | undefined {
  const lines = output.split('\n');
  for (const line of lines) {
    const token = line.split(/\s/u)[0]?.trim();
    if (token !== undefined && COMMIT_PATTERN.test(token)) {
      return token;
    }
  }
  return undefined;
}

function excerpt(output: string): string {
  return output.trim().replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

const NOT_CONFIGURED_PUBLICATION: DoctorPublicationReport = {
  configured: false,
  eligible: false,
  remote: null,
  repository: null,
  repositoryScope: 'unknown',
  reason: null,
  capabilities: [],
};

function unknownPublicationCapabilities(): ReadonlyArray<DoctorPublicationCapabilityReport> {
  return PUBLICATION_CAPABILITIES.map((capability) => ({ capability, state: 'unknown' }));
}

function unavailablePublicationReport(
  reason: string,
  remote: string | null,
  repository: string | null,
): DoctorPublicationReport {
  return {
    configured: true,
    eligible: false,
    remote,
    repository,
    repositoryScope: 'unknown',
    reason,
    capabilities: unknownPublicationCapabilities(),
  };
}

function summarizePublicationObservation(
  remote: string,
  repository: string,
  observation: PublicationProbeObservation,
): DoctorPublicationReport {
  if (!observation.tokenPresent) {
    return unavailablePublicationReport(
      'GITHUB_TOKEN is not set for the configured publication remote.',
      remote,
      repository,
    );
  }
  const repositoryScope = publicationRepositoryScope(observation.tokenScopes);
  const capabilities: ReadonlyArray<DoctorPublicationCapabilityReport> = [
    { capability: 'push', state: observation.push ? 'granted' : 'denied' },
    { capability: 'pull_request', state: observation.push ? 'granted' : 'denied' },
    {
      capability: 'issue_comment_read',
      state:
        observation.issueCommentReadable === null
          ? 'unknown'
          : observation.issueCommentReadable
            ? 'granted'
            : 'denied',
    },
    {
      capability: 'collaborator_permission',
      state: observation.collaboratorPermission === null ? 'unknown' : 'granted',
    },
  ];
  const unresolved = capabilities.filter((entry) => entry.state !== 'granted');
  let reason: string | null = null;
  if (!githubRepositoriesMatch(observation.repository, repository)) {
    reason = `Credential identifies GitHub repository "${observation.repository}" instead of the configured publication repository "${repository}".`;
  } else if (repositoryScope === 'broad') {
    reason = 'Credential is not limited to the configured publication repository.';
  } else if (unresolved.length > 0) {
    reason = `Credential cannot confirm required GitHub capabilities: ${unresolved
      .map((entry) => entry.capability)
      .join(', ')}.`;
  } else if (observation.limitations.length > 0) {
    reason = observation.limitations.join(' ');
  }
  return {
    configured: true,
    eligible: reason === null,
    remote,
    repository,
    repositoryScope,
    reason,
    capabilities,
  };
}

export function branchProtectionEvidenceFromProbeResult(input: {
  readonly publicationConfigured: boolean;
  readonly observation: PublicationProbeObservation | null;
  readonly probeUnavailableReason: string | null;
}): BranchProtectionEvidence {
  if (!input.publicationConfigured) {
    return BRANCH_PROTECTION_NOT_CONFIGURED;
  }
  if (input.observation === null) {
    return {
      _tag: 'Uncertain',
      reason:
        input.probeUnavailableReason ??
        'GitHub protected branch evidence could not be resolved for the configured publication repository.',
    };
  }
  if (input.observation.protectedBranches === null) {
    return {
      _tag: 'Uncertain',
      reason:
        'GitHub protected branch names could not be established for the configured publication repository.',
    };
  }
  return { _tag: 'Known', protectedBranches: input.observation.protectedBranches };
}

export const resolveBranchProtectionEvidence = Effect.fn('resolveBranchProtectionEvidence')(
  function* (
    publication: DecisionPublicationConfiguration | null,
    repositoryPath: string,
  ): Effect.fn.Return<BranchProtectionEvidence, ReadinessError, ReadinessGit | PublicationProbe> {
    if (publication === null) {
      return BRANCH_PROTECTION_NOT_CONFIGURED;
    }
    const git = yield* ReadinessGit;
    const remoteUrlResult = yield* git.run(
      ['remote', 'get-url', publication.remote],
      repositoryPath,
    );
    if (remoteUrlResult.exitCode !== 0 || remoteUrlResult.stdout.trim().length === 0) {
      return branchProtectionEvidenceFromProbeResult({
        publicationConfigured: true,
        observation: null,
        probeUnavailableReason: `Cannot resolve publication remote "${publication.remote}" in target repository at ${repositoryPath}.`,
      });
    }
    const reference = parseGitHubRepositoryRemote(remoteUrlResult.stdout);
    if (reference === undefined) {
      return branchProtectionEvidenceFromProbeResult({
        publicationConfigured: true,
        observation: null,
        probeUnavailableReason: `Publication remote "${publication.remote}" is not a GitHub repository.`,
      });
    }
    const repository = renderGitHubRepository(reference);
    const probe = yield* Effect.serviceOption(PublicationProbe);
    if (Option.isNone(probe)) {
      return branchProtectionEvidenceFromProbeResult({
        publicationConfigured: true,
        observation: null,
        probeUnavailableReason: `GitHub publication probe is unavailable for remote "${publication.remote}".`,
      });
    }
    const observed = yield* probe.value.observe({ repository }).pipe(Effect.result);
    if (Result.isFailure(observed)) {
      return branchProtectionEvidenceFromProbeResult({
        publicationConfigured: true,
        observation: null,
        probeUnavailableReason: observed.failure.message,
      });
    }
    return branchProtectionEvidenceFromProbeResult({
      publicationConfigured: true,
      observation: observed.success,
      probeUnavailableReason: null,
    });
  },
);

export const describePublicationReadiness = Effect.fn('describePublicationReadiness')(function* (
  publication: DecisionPublicationConfiguration | null,
  repositoryPath: string,
): Effect.fn.Return<DoctorPublicationReport, ReadinessError, ReadinessGit> {
  if (publication === null) {
    return NOT_CONFIGURED_PUBLICATION;
  }
  const git = yield* ReadinessGit;
  const remoteUrlResult = yield* git.run(['remote', 'get-url', publication.remote], repositoryPath);
  if (remoteUrlResult.exitCode !== 0 || remoteUrlResult.stdout.trim().length === 0) {
    return unavailablePublicationReport(
      `Cannot resolve publication remote "${publication.remote}" in target repository at ${repositoryPath}.`,
      publication.remote,
      null,
    );
  }
  const reference = parseGitHubRepositoryRemote(remoteUrlResult.stdout);
  if (reference === undefined) {
    return unavailablePublicationReport(
      `Publication remote "${publication.remote}" is not a GitHub repository.`,
      publication.remote,
      null,
    );
  }
  const repository = renderGitHubRepository(reference);
  const probe = yield* Effect.serviceOption(PublicationProbe);
  if (Option.isNone(probe)) {
    return unavailablePublicationReport(
      `GitHub publication probe is unavailable for remote "${publication.remote}".`,
      publication.remote,
      repository,
    );
  }
  const observed = yield* probe.value.observe({ repository }).pipe(Effect.result);
  if (Result.isFailure(observed)) {
    return unavailablePublicationReport(observed.failure.message, publication.remote, repository);
  }
  return summarizePublicationObservation(publication.remote, repository, observed.success);
});

export const checkReadiness = Effect.fn('checkReadiness')(function* (
  options: CheckReadinessOptions,
): Effect.fn.Return<
  DoctorReport,
  ReadinessError | RoleHostCapabilityError,
  ReadinessHost | ReadinessFiles | ReadinessGit | RoleHostLauncher
> {
  const host = yield* ReadinessHost;
  const files = yield* ReadinessFiles;
  const git = yield* ReadinessGit;

  const platform = yield* host.platform;
  if (!isSupportedPlatform(platform)) {
    return yield* new ReadinessError({
      message: `Unsupported operating system: ${displayPlatform(platform)}. Expected linux or windows.`,
    });
  }

  const nodeVersion = normalizeToolVersion(yield* host.nodeVersion);
  if (nodeVersion !== REQUIRED_NODE_VERSION) {
    return yield* new ReadinessError({
      message: `Unsupported Node.js version: ${nodeVersion}. Expected ${REQUIRED_NODE_VERSION}.`,
    });
  }

  const npmVersion = normalizeToolVersion(yield* host.npmVersion);
  if (npmVersion !== REQUIRED_NPM_VERSION) {
    return yield* new ReadinessError({
      message: `Unsupported npm version: ${npmVersion}. Expected ${REQUIRED_NPM_VERSION}.`,
    });
  }

  const gitOutput = yield* host.gitVersionOutput;
  const gitVersion = parseGitVersion(gitOutput);
  if (gitVersion === undefined) {
    return yield* new ReadinessError({
      message: `Unable to determine Git version from: ${excerpt(gitOutput)}. Expected Git 2.43 or newer.`,
    });
  }
  if (!isSupportedGitVersion(gitVersion)) {
    return yield* new ReadinessError({
      message: `Unsupported Git version: ${gitVersion.major}.${gitVersion.minor}. Expected Git 2.43 or newer.`,
    });
  }

  const configPath = resolve(options.cwd, options.configArg);
  const configText = yield* files.readFile(configPath);
  const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
    configText,
  ).pipe(
    Effect.mapError(
      (error) =>
        new ReadinessError({
          message: `Configuration document at ${configPath} is not valid JSON: ${excerpt(error.message)}.`,
        }),
    ),
  );
  const configuration = yield* decodeProjectConfiguration(document, dirname(configPath)).pipe(
    Effect.mapError((error) => new ReadinessError({ message: error.message })),
  );

  const invalidPatterns = invalidRedactionPatterns(configuration.artifacts.redactionPatterns);
  if (invalidPatterns.length > 0) {
    const first = invalidPatterns[0];
    return yield* new ReadinessError({
      message: `Redaction pattern ${JSON.stringify(first?.pattern ?? '')} is not a valid ECMAScript regular expression: ${first?.problem ?? 'invalid pattern'}.`,
    });
  }

  const repositoryPath = configuration.targetRepository;
  const insideWorkTree = yield* git.run(['rev-parse', '--is-inside-work-tree'], repositoryPath);
  if (insideWorkTree.exitCode !== 0 || insideWorkTree.stdout.trim() !== 'true') {
    return yield* new ReadinessError({
      message: `Target repository at ${repositoryPath} is not a Git work tree.`,
    });
  }

  const remotes = yield* git.run(['remote'], repositoryPath);
  if (remotes.exitCode !== 0) {
    return yield* new ReadinessError({
      message: `Cannot list Git remotes in target repository at ${repositoryPath}.`,
    });
  }
  const remoteNames = remotes.stdout
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (!remoteNames.includes(configuration.sourceRemote)) {
    return yield* new ReadinessError({
      message: `Source remote "${configuration.sourceRemote}" is not configured in target repository at ${repositoryPath}.`,
    });
  }

  const reachable = yield* git.run(
    ['ls-remote', configuration.sourceRemote, configuration.sourceBranch],
    repositoryPath,
  );
  const commit = reachable.exitCode === 0 ? firstReachableCommit(reachable.stdout) : undefined;
  if (commit === undefined) {
    return yield* new ReadinessError({
      message: `Source branch "${configuration.sourceBranch}" is not reachable on remote "${configuration.sourceRemote}".`,
    });
  }

  const gitDirResult = yield* git.run(['rev-parse', '--absolute-git-dir'], repositoryPath);
  if (gitDirResult.exitCode !== 0 || gitDirResult.stdout.trim().length === 0) {
    return yield* new ReadinessError({
      message: `Cannot locate the Git directory for target repository at ${repositoryPath}.`,
    });
  }
  const gitDir = resolve(repositoryPath, gitDirResult.stdout.trim());
  for (const marker of GIT_OPERATION_MARKERS) {
    const markerStatus = yield* files.statPath(join(gitDir, marker.marker));
    if (markerStatus.exists) {
      return yield* new ReadinessError({
        message: `Git ${marker.operation} in progress in target repository at ${repositoryPath}.`,
      });
    }
  }

  const status = yield* git.run(['status', '--porcelain'], repositoryPath);
  if (status.exitCode !== 0) {
    return yield* new ReadinessError({
      message: `Cannot assess Git status in target repository at ${repositoryPath}.`,
    });
  }
  if (status.stdout.trim().length > 0) {
    return yield* new ReadinessError({
      message: `Target repository at ${repositoryPath} is not clean: ${excerpt(status.stdout)}.`,
    });
  }

  const storagePath = join(repositoryPath, RUN_STORAGE_DIRECTORY_NAME);
  const ignoreCheck = yield* git.run(
    ['check-ignore', '-q', RUN_STORAGE_DIRECTORY_NAME],
    repositoryPath,
  );
  if (ignoreCheck.exitCode !== 0 && ignoreCheck.exitCode !== 1) {
    return yield* new ReadinessError({
      message: `Cannot assess Git ignore rules in target repository at ${repositoryPath}.`,
    });
  }
  if (ignoreCheck.exitCode !== 0) {
    return yield* new ReadinessError({
      message: `Run storage at ${storagePath} is not ignored by Git.`,
    });
  }

  const tracked = yield* git.run(['ls-files', '--', RUN_STORAGE_DIRECTORY_NAME], repositoryPath);
  if (tracked.exitCode !== 0) {
    return yield* new ReadinessError({
      message: `Cannot assess tracked files in target repository at ${repositoryPath}.`,
    });
  }
  if (tracked.stdout.trim().length > 0) {
    return yield* new ReadinessError({
      message: `Run storage at ${storagePath} is tracked by Git.`,
    });
  }

  const storageStatus = yield* files.statPath(storagePath);
  if (storageStatus.exists) {
    if (!storageStatus.isDirectory) {
      return yield* new ReadinessError({
        message: `Run storage at ${storagePath} is not a usable directory.`,
      });
    }
  } else {
    const parentStatus = yield* files.statPath(repositoryPath);
    const parentWritable = yield* files.isWritable(repositoryPath);
    if (!parentStatus.exists || !parentStatus.isDirectory || !parentWritable) {
      return yield* new ReadinessError({
        message: `Run storage at ${storagePath} is not a usable directory location.`,
      });
    }
  }

  const capabilities = yield* preflightRoleHostCapabilities({ configuration });

  const publication = yield* describePublicationReadiness(
    configuration.decisionPublication,
    repositoryPath,
  );

  return {
    host: {
      platform: displayPlatform(platform),
      nodeVersion,
      npmVersion,
      gitVersion: extractGitVersionNumber(gitOutput) ?? gitOutput.trim(),
    },
    config: {
      path: configPath,
      schemaVersion: configuration.schemaVersion,
    },
    storage: {
      path: storagePath,
      ignored: true,
    },
    repository: {
      path: repositoryPath,
      remote: configuration.sourceRemote,
      branch: configuration.sourceBranch,
      commit,
    },
    roleHost: {
      protocol: capabilities.protocol,
      adapterVersion: capabilities.adapterVersion,
      resumable: true,
      availableRoles: [...capabilities.availableRoles],
      filesystemProfiles: [...capabilities.capabilityProfiles.filesystem],
      networkProfiles: [...capabilities.capabilityProfiles.network],
    },
    publication,
  };
});
