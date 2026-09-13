import { Effect, Schema } from 'effect';
import { join } from 'node:path';

import { VERIFICATION_GATES, verificationProfileHash } from '../../domain/project-verification.js';
import { resolveCommandVector, runGuardedProjectCommand } from '../project-commands/index.js';
import { ReadinessGit } from '../readiness/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../run-history/index.js';

import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type {
  ProjectVerificationReport,
  VerificationCommandProfile,
  VerificationExecution,
} from '../../domain/project-verification.js';
import type {
  GuardedProjectCommandOutcome,
  ProjectCommandProcess,
  ProjectEvidenceStore,
} from '../project-commands/index.js';
import type { RunHistoryError, RunHistoryStorage } from '../run-history/index.js';

export class ProjectVerificationError extends Schema.TaggedError<ProjectVerificationError>()(
  'ProjectVerificationError',
  {
    message: Schema.String,
  },
) {}

export interface RunProjectVerificationOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly repositoryPath: string;
  readonly configDirectory: string;
  readonly commit: string;
  readonly configuration: ProjectConfiguration;
}

const verificationCache = new Map<string, ProjectVerificationReport>();

function cacheKey(
  runId: string,
  repositoryPath: string,
  commit: string,
  profileHash: string,
): string {
  return `${runId}\u0000${repositoryPath}\u0000${commit}\u0000${profileHash}`;
}

function excerpt(output: string): string {
  return output.trim().replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

function executionOf(
  kind: 'bootstrap' | 'gate',
  name: string,
  outcome: GuardedProjectCommandOutcome,
): VerificationExecution {
  return {
    kind,
    name,
    executable: outcome.executable,
    arguments: [...outcome.arguments],
    expectedExitCode: 0,
    actualExitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
    log: outcome.log,
    trackedMutation:
      outcome.mutation === null || outcome.mutationDiff === null
        ? null
        : {
            sha256: outcome.mutation.diffSha256,
            byteLength: outcome.mutation.diffByteLength,
            retainedByteLength: outcome.mutationDiff.retainedByteLength,
            truncated: outcome.mutation.diffTruncated,
            diff: outcome.mutationDiff,
          },
    reconstructed: outcome.reconstructed,
    reconstructionError: outcome.reconstructionError,
  };
}

function isPassing(outcome: GuardedProjectCommandOutcome): boolean {
  return (
    !outcome.timedOut &&
    outcome.exitCode === 0 &&
    outcome.mutation === null &&
    outcome.reconstructionError === null
  );
}

function buildProfile(
  configuration: ProjectConfiguration,
  configDirectory: string,
): VerificationCommandProfile {
  const bootstrap = configuration.projectProfile.commands.bootstrap;
  return {
    commandMs: configuration.timeouts.commandMs,
    bootstrap:
      bootstrap === null
        ? null
        : { name: 'bootstrap', command: resolveCommandVector(configDirectory, bootstrap) },
    gates: VERIFICATION_GATES.map((name) => ({
      name,
      command: resolveCommandVector(configDirectory, configuration.projectProfile.commands[name]),
    })),
  };
}

const verifyHead = Effect.fn('runProjectVerification.verifyHead')(function* (
  options: RunProjectVerificationOptions,
): Effect.fn.Return<void, ProjectVerificationError, ReadinessGit> {
  const git = yield* ReadinessGit;
  const head = yield* git
    .run(['rev-parse', 'HEAD'], options.repositoryPath)
    .pipe(Effect.mapError((error) => new ProjectVerificationError({ message: error.message })));
  if (head.exitCode !== 0 || head.stdout.trim() !== options.commit) {
    return yield* new ProjectVerificationError({
      message: `Verification refuses to run: HEAD ${excerpt(head.stdout)} does not match the accepted implementation commit ${options.commit}.`,
    });
  }
  const status = yield* git
    .run(['status', '--porcelain=v1', '--untracked-files=no'], options.repositoryPath)
    .pipe(Effect.mapError((error) => new ProjectVerificationError({ message: error.message })));
  if (status.exitCode !== 0 || status.stdout.trim().length > 0) {
    return yield* new ProjectVerificationError({
      message: `Verification refuses to run: the run-owned worktree at ${options.repositoryPath} is not clean at the accepted commit.`,
    });
  }
});

export const runProjectVerification = Effect.fn('runProjectVerification')(function* (
  options: RunProjectVerificationOptions,
): Effect.fn.Return<
  ProjectVerificationReport,
  ProjectVerificationError | RunHistoryError,
  ReadinessGit | ProjectCommandProcess | ProjectEvidenceStore | RunHistoryStorage
> {
  const profile = buildProfile(options.configuration, options.configDirectory);
  const profileHash = verificationProfileHash(profile);
  const key = cacheKey(options.runId, options.repositoryPath, options.commit, profileHash);
  const cached = verificationCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  yield* verifyHead(options);

  const history = yield* readVerifiedRunHistory({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  const attempt = history.derived.verifications.length + 1;

  const evidenceDirectory = join(options.runDirectory, 'evidence');
  const commandMs = profile.commandMs;
  const executions: Array<VerificationExecution> = [];

  const runStep = Effect.fn('runProjectVerification.step')(function* (
    kind: 'bootstrap' | 'gate',
    entry: { readonly name: string; readonly command: ReadonlyArray<string> },
  ): Effect.fn.Return<
    GuardedProjectCommandOutcome,
    ProjectVerificationError,
    ReadinessGit | ProjectCommandProcess | ProjectEvidenceStore
  > {
    return yield* runGuardedProjectCommand({
      kind,
      name: entry.name,
      command: entry.command,
      cwd: options.repositoryPath,
      repositoryPath: options.repositoryPath,
      timeoutMs: commandMs,
      maxLogBytes: options.configuration.artifacts.maxTerminalCaptureBytes,
      maxDiffBytes: options.configuration.artifacts.maxEvidenceBytes,
      redactionPatterns: options.configuration.artifacts.redactionPatterns,
      evidenceDirectory,
      reconstruct: true,
    }).pipe(Effect.mapError((error) => new ProjectVerificationError({ message: error.message })));
  });

  let unresolved = false;
  let bootstrapOk = profile.bootstrap === null;
  if (profile.bootstrap !== null) {
    const outcome = yield* runStep('bootstrap', profile.bootstrap);
    executions.push(executionOf('bootstrap', profile.bootstrap.name, outcome));
    bootstrapOk = isPassing(outcome);
    if (outcome.reconstructionError !== null) {
      unresolved = true;
    }
  }

  if (bootstrapOk && !unresolved) {
    for (const gate of profile.gates) {
      const outcome = yield* runStep('gate', gate);
      executions.push(executionOf('gate', gate.name, outcome));
      if (outcome.reconstructionError !== null) {
        unresolved = true;
        break;
      }
    }
  }

  const expectedExecutions = (profile.bootstrap === null ? 0 : 1) + profile.gates.length;
  const result: ProjectVerificationReport['result'] =
    !unresolved && executions.length === expectedExecutions && executions.every(isExecutionPassing)
      ? 'passed'
      : 'failed';

  const report: ProjectVerificationReport = {
    attempt,
    repository: options.repositoryPath,
    commit: options.commit,
    profileHash,
    commandMs,
    executions,
    result,
  };

  yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
    build: () => Effect.succeed({ type: 'verification-completed', payload: report } as const),
  });

  verificationCache.set(key, report);
  return report;
});

function isExecutionPassing(execution: VerificationExecution): boolean {
  return (
    !execution.timedOut &&
    execution.actualExitCode === execution.expectedExitCode &&
    execution.trackedMutation === null &&
    execution.reconstructionError === null
  );
}
