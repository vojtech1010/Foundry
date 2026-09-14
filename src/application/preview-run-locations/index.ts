import { Effect, Option, Schema } from 'effect';
import { dirname, join, resolve } from 'node:path';

import { TASK_ID_PLACEHOLDER } from '../../domain/project-configuration.js';
import { RUN_STORAGE_DIRECTORY_NAME } from '../../domain/readiness.js';
import {
  RUNS_DIRECTORY_NAME,
  preflightTaskBranch,
  renderTaskBranch,
  renderWorkspacePath,
} from '../../domain/run-locations.js';
import {
  checkReadiness,
  ReadinessFiles,
  resolveBranchProtectionEvidence,
  resolveRoleRouting,
} from '../readiness/index.js';
import { decodeProjectConfiguration } from '../project-configuration.js';

import type {
  ReadinessError,
  ReadinessGit,
  ReadinessHost,
  RoleRoutingReport,
  PublicationProbe,
} from '../readiness/index.js';
import type { RoleHostCapabilityError, RoleHostLauncher } from '../role-conversations/index.js';
import type { CommandVector } from '../../domain/project-configuration.js';
import type { BranchProtectionEvidence } from '../../domain/run-locations.js';

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
  readonly retentionDays: number;
  readonly maxRequestBytes: number;
  readonly maxGuidanceBytes: number;
  readonly maxRoleHandoffBytes: number;
  readonly maxEvidenceBytes: number;
  readonly maxTerminalCaptureBytes: number;
  readonly maxRunBytes: number;
  readonly redactionPatterns: ReadonlyArray<string>;
}

export interface PreviewLocationsReport {
  readonly taskId: string;
  readonly source: PreviewSourceReport;
  readonly branch: string;
  readonly workspace: string;
  readonly roleHarness: PreviewRoleHarnessReport;
  // INTEGRATE-W1: optional until CODER-053A promotes the closed `roles`
  // contract into `ProjectConfiguration`; reports omit the section instead
  // of inventing routing. See `resolveRoleRouting`.
  readonly roleRouting: ReadonlyArray<RoleRoutingReport> | undefined;
  readonly artifacts: PreviewArtifactsReport;
}

export interface PreviewRunLocationsOptions {
  readonly configArg: string;
  readonly cwd: string;
  readonly taskId: string;
  readonly protection?: BranchProtectionEvidence;
}

function excerpt(output: string): string {
  return output.trim().replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

export const previewRunLocations = Effect.fn('previewRunLocations')(function* (
  options: PreviewRunLocationsOptions,
): Effect.fn.Return<
  PreviewLocationsReport,
  PreviewLocationsError | ReadinessError | RoleHostCapabilityError,
  ReadinessHost | ReadinessFiles | ReadinessGit | PublicationProbe | RoleHostLauncher
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
  const protection =
    options.protection ??
    (yield* resolveBranchProtectionEvidence(
      configuration.decisionPublication,
      configuration.targetRepository,
    ).pipe(Effect.mapError((error) => new PreviewLocationsError({ message: error.message }))));
  const preflight = preflightTaskBranch({
    taskBranch: branch,
    sourceBranch: configuration.sourceBranch,
    protection,
  });
  if (preflight._tag === 'Rejected') {
    const message =
      preflight.rejection._tag === 'IllegalName'
        ? `Rendered task branch "${branch}" from policy "${configuration.taskBranchPolicy}" with task ID "${options.taskId}" is not a legal Git branch name. Placeholder is ${TASK_ID_PLACEHOLDER}.`
        : preflight.rejection.message;
    return yield* new PreviewLocationsError({ message });
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
    roleRouting: Option.getOrUndefined(resolveRoleRouting(configuration)),
    artifacts: {
      root: artifactsRoot,
      retentionDays: configuration.artifacts.retentionDays,
      maxRequestBytes: configuration.artifacts.maxRequestBytes,
      maxGuidanceBytes: configuration.artifacts.maxGuidanceBytes,
      maxRoleHandoffBytes: configuration.artifacts.maxRoleHandoffBytes,
      maxEvidenceBytes: configuration.artifacts.maxEvidenceBytes,
      maxTerminalCaptureBytes: configuration.artifacts.maxTerminalCaptureBytes,
      maxRunBytes: configuration.artifacts.maxRunBytes,
      redactionPatterns: [...configuration.artifacts.redactionPatterns],
    },
  };
});
