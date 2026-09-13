import { Effect, Schema } from 'effect';
import { dirname, join, resolve } from 'node:path';

import { TASK_ID_PLACEHOLDER } from '../../domain/project-configuration.js';
import { RUN_STORAGE_DIRECTORY_NAME } from '../../domain/readiness.js';
import {
  RUNS_DIRECTORY_NAME,
  isLegalGitBranchName,
  renderTaskBranch,
  renderWorkspacePath,
} from '../../domain/run-locations.js';
import { checkReadiness, ReadinessFiles } from '../readiness/index.js';
import { decodeProjectConfiguration } from '../project-configuration.js';

import type { ReadinessError, ReadinessGit, ReadinessHost } from '../readiness/index.js';
import type { RoleHostCapabilityError, RoleHostLauncher } from '../role-conversations/index.js';
import type { CommandVector } from '../../domain/project-configuration.js';

export class PreviewLocationsError extends Schema.TaggedError<PreviewLocationsError>()(
  'PreviewLocationsError',
  {
    message: Schema.String,
  },
) {}

export interface PreviewSourceReport {
  readonly remote: string;
  readonly branch: string;
  readonly commit: string;
}

export interface PreviewRoleHarnessReport {
  readonly protocol: string;
  readonly command: CommandVector;
}

export interface PreviewArtifactsReport {
  readonly root: string;
}

export interface PreviewLocationsReport {
  readonly taskId: string;
  readonly source: PreviewSourceReport;
  readonly branch: string;
  readonly workspace: string;
  readonly roleHarness: PreviewRoleHarnessReport;
  readonly artifacts: PreviewArtifactsReport;
}

export interface PreviewRunLocationsOptions {
  readonly configArg: string;
  readonly cwd: string;
  readonly taskId: string;
}

function excerpt(output: string): string {
  return output.trim().replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

export const previewRunLocations = Effect.fn('previewRunLocations')(function* (
  options: PreviewRunLocationsOptions,
): Effect.fn.Return<
  PreviewLocationsReport,
  PreviewLocationsError | ReadinessError | RoleHostCapabilityError,
  ReadinessHost | ReadinessFiles | ReadinessGit | RoleHostLauncher
> {
  const readiness = yield* checkReadiness({ configArg: options.configArg, cwd: options.cwd });

  const configPath = resolve(options.cwd, options.configArg);
  const files = yield* ReadinessFiles;
  const configText = yield* files.readFile(configPath);
  const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
    configText,
  ).pipe(
    Effect.mapError(
      (error) =>
        new PreviewLocationsError({
          message: `Configuration document at ${configPath} is not valid JSON: ${excerpt(error.message)}.`,
        }),
    ),
  );
  const configuration = yield* decodeProjectConfiguration(document, dirname(configPath)).pipe(
    Effect.mapError((error) => new PreviewLocationsError({ message: error.message })),
  );

  const branch = renderTaskBranch(configuration.taskBranchPolicy, options.taskId);
  if (branch === configuration.sourceBranch) {
    return yield* new PreviewLocationsError({
      message: `Rendered task branch "${branch}" must not equal source branch "${configuration.sourceBranch}".`,
    });
  }
  if (!isLegalGitBranchName(branch)) {
    return yield* new PreviewLocationsError({
      message: `Rendered task branch "${branch}" from policy "${configuration.taskBranchPolicy}" with task ID "${options.taskId}" is not a legal Git branch name. Placeholder is ${TASK_ID_PLACEHOLDER}.`,
    });
  }

  const workspace = renderWorkspacePath(configuration.targetRepository, options.taskId);
  const artifactsRoot = join(
    configuration.targetRepository,
    RUN_STORAGE_DIRECTORY_NAME,
    RUNS_DIRECTORY_NAME,
  );

  return {
    taskId: options.taskId,
    source: {
      remote: readiness.repository.remote,
      branch: readiness.repository.branch,
      commit: readiness.repository.commit,
    },
    branch,
    workspace,
    roleHarness: {
      protocol: configuration.roleHarness.protocol,
      command: configuration.roleHarness.command,
    },
    artifacts: {
      root: artifactsRoot,
    },
  };
});
