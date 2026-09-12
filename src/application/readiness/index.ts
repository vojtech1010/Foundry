import { Context, Effect, Schema } from 'effect';
import { dirname, join, resolve } from 'node:path';

import {
  GIT_OPERATION_MARKERS,
  REQUIRED_NODE_VERSION,
  REQUIRED_NPM_VERSION,
  RUN_STORAGE_DIRECTORY_NAME,
  displayPlatform,
  extractGitVersionNumber,
  isSupportedGitVersion,
  isSupportedPlatform,
  normalizeToolVersion,
  parseGitVersion,
} from '../../domain/readiness.js';

import { decodeProjectConfiguration } from '../project-configuration.js';

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

export interface DoctorReport {
  readonly host: DoctorHostReport;
  readonly config: DoctorConfigReport;
  readonly storage: DoctorStorageReport;
  readonly repository: DoctorRepositoryReport;
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

export const checkReadiness = Effect.fn('checkReadiness')(function* (
  options: CheckReadinessOptions,
): Effect.fn.Return<DoctorReport, ReadinessError, ReadinessHost | ReadinessFiles | ReadinessGit> {
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
  };
});
