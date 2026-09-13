import { Clock, Context, Duration, Effect, Result, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { admitOptionalEvidence, redactText } from '../evidence-limits/index.js';
import { ReadinessGit } from '../readiness/index.js';

import type { EvidenceLedger, OptionalEvidenceRefusalReason } from '../evidence-limits/index.js';
import type { VerificationLogReference } from '../../domain/project-verification.js';
import type { RuntimeCleanupDisposition } from '../../domain/project-runtime.js';

export class ProjectCommandError extends Schema.TaggedError<ProjectCommandError>()(
  'ProjectCommandError',
  {
    message: Schema.String,
  },
) {}

export class ProjectEvidenceError extends Schema.TaggedError<ProjectEvidenceError>()(
  'ProjectEvidenceError',
  {
    message: Schema.String,
  },
) {}

export interface ProjectCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunProjectCommandOptions {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
}

export class ProjectCommandProcess extends Context.Service<
  ProjectCommandProcess,
  {
    readonly run: (
      options: RunProjectCommandOptions,
    ) => Effect.Effect<ProjectCommandResult, ProjectCommandError>;
  }
>()('foundry/application/project-commands/Process') {}

export interface TrackedSnapshot {
  readonly head: string;
  readonly status: string;
}

export interface TrackedMutation {
  readonly diff: string;
  readonly diffByteLength: number;
  readonly diffTruncated: boolean;
  readonly diffSha256: string;
  readonly diffRedactionCount: number;
}

export interface WriteEvidenceOptions {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export class ProjectEvidenceStore extends Context.Service<
  ProjectEvidenceStore,
  {
    readonly write: (options: WriteEvidenceOptions) => Effect.Effect<void, ProjectEvidenceError>;
  }
>()('foundry/application/project-commands/EvidenceStore') {}

export interface OwnedProcessHandle {
  readonly id: string;
  readonly pid: number | null;
  readonly command: ReadonlyArray<string>;
}

export interface StartOwnedProcessOptions {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly maxLogBytes: number;
}

export interface TerminateOwnedProcessOptions {
  readonly handle: OwnedProcessHandle;
  readonly graceMs: number;
}

export interface TerminateOwnedProcessResult {
  readonly disposition: RuntimeCleanupDisposition;
  readonly detail: string;
}

export class OwnedProjectProcess extends Context.Service<
  OwnedProjectProcess,
  {
    readonly start: (
      options: StartOwnedProcessOptions,
    ) => Effect.Effect<OwnedProcessHandle, ProjectCommandError>;
    readonly terminate: (
      options: TerminateOwnedProcessOptions,
    ) => Effect.Effect<TerminateOwnedProcessResult, ProjectCommandError>;
  }
>()('foundry/application/project-commands/OwnedProjectProcess') {}

export interface GuardedProjectCommandOptions {
  readonly kind: 'bootstrap' | 'gate' | 'runtime';
  readonly name: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly repositoryPath: string;
  readonly timeoutMs: number;
  readonly maxLogBytes: number;
  readonly maxDiffBytes: number;
  readonly redactionPatterns: ReadonlyArray<string>;
  readonly evidenceDirectory: string;
  readonly reconstruct: boolean;
  readonly evidenceLedger?: EvidenceLedger | undefined;
}

export interface OptionalEvidenceRefusal {
  readonly kind: 'log' | 'mutation-diff';
  readonly reason: OptionalEvidenceRefusalReason;
}

export interface GuardedProjectCommandOutcome {
  readonly kind: 'bootstrap' | 'gate' | 'runtime';
  readonly name: string;
  readonly executable: string;
  readonly arguments: ReadonlyArray<string>;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly snapshotBefore: TrackedSnapshot;
  readonly snapshotAfter: TrackedSnapshot;
  readonly mutation: TrackedMutation | null;
  readonly mutationDiff: VerificationLogReference | null;
  readonly reconstructed: boolean;
  readonly reconstructionError: string | null;
  readonly log: VerificationLogReference;
  readonly evidenceRefusals: ReadonlyArray<OptionalEvidenceRefusal>;
  readonly detail: string;
}

function excerpt(output: string, limit = 500): string {
  return output.trim().replaceAll(/\s+/gu, ' ').trim().slice(0, limit);
}

function containsPathSeparator(executable: string): boolean {
  return executable.includes('/') || executable.includes('\\');
}

export function resolveCommandVector(
  configDirectory: string,
  command: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const [executable, ...rest] = command;
  if (executable === undefined || !containsPathSeparator(executable)) {
    return [...command];
  }
  return [join(configDirectory, executable), ...rest];
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function boundLog(text: string, maxLogBytes: number, patterns: ReadonlyArray<string>) {
  const { text: redactedText, redactionCount } = redactText(text, patterns);
  const fullBytes = new TextEncoder().encode(redactedText);
  const retainedText =
    fullBytes.byteLength <= maxLogBytes ? redactedText : redactedText.slice(0, maxLogBytes);
  const retainedByteLength = new TextEncoder().encode(retainedText).byteLength;
  return {
    retained: retainedText,
    retainedByteLength,
    byteLength: fullBytes.byteLength,
    truncated: retainedByteLength < fullBytes.byteLength,
    redactionCount,
    sha256: sha256Hex(redactedText),
  };
}

const readSnapshot = Effect.fn('projectCommands.readSnapshot')(function* (
  git: ReadinessGit['Service'],
  repositoryPath: string,
  commandName: string,
): Effect.fn.Return<TrackedSnapshot, ProjectCommandError> {
  const head = yield* git
    .run(['rev-parse', 'HEAD'], repositoryPath)
    .pipe(Effect.mapError((error) => new ProjectCommandError({ message: error.message })));
  if (head.exitCode !== 0) {
    return yield* new ProjectCommandError({
      message: `Cannot snapshot tracked Git state before project command "${commandName}": ${excerpt(head.stdout)}.`,
    });
  }
  const status = yield* git
    .run(['status', '--porcelain=v1', '--untracked-files=no'], repositoryPath)
    .pipe(Effect.mapError((error) => new ProjectCommandError({ message: error.message })));
  if (status.exitCode !== 0) {
    return yield* new ProjectCommandError({
      message: `Cannot snapshot tracked Git state before project command "${commandName}": ${excerpt(status.stdout)}.`,
    });
  }
  return { head: head.stdout.trim(), status: status.stdout };
});

const captureMutation = Effect.fn('projectCommands.captureMutation')(function* (
  git: ReadinessGit['Service'],
  repositoryPath: string,
  maxDiffBytes: number,
  patterns: ReadonlyArray<string>,
): Effect.fn.Return<TrackedMutation, ProjectCommandError> {
  const diff = yield* git
    .run(['diff', 'HEAD', '--no-color'], repositoryPath)
    .pipe(Effect.mapError((error) => new ProjectCommandError({ message: error.message })));
  if (diff.exitCode !== 0) {
    return {
      diff: '',
      diffByteLength: 0,
      diffTruncated: false,
      diffSha256: sha256Hex(''),
      diffRedactionCount: 0,
    };
  }
  const { text: full, redactionCount } = redactText(diff.stdout, patterns);
  const truncated = new TextEncoder().encode(full).byteLength > maxDiffBytes;
  const bounded = truncated ? full.slice(0, maxDiffBytes) : full;
  return {
    diff: bounded,
    diffByteLength: new TextEncoder().encode(full).byteLength,
    diffTruncated: truncated,
    diffSha256: sha256Hex(full),
    diffRedactionCount: redactionCount,
  };
});

export const reconstructTrackedWorktree = Effect.fn('reconstructTrackedWorktree')(function* (
  git: ReadinessGit['Service'],
  repositoryPath: string,
  targetCommit: string,
  commandName: string,
): Effect.fn.Return<void, ProjectCommandError> {
  const reset = yield* git
    .run(['reset', '--hard', targetCommit], repositoryPath)
    .pipe(Effect.mapError((error) => new ProjectCommandError({ message: error.message })));
  if (reset.exitCode !== 0) {
    return yield* new ProjectCommandError({
      message: `Cannot reconstruct the run-owned worktree at ${targetCommit} after project command "${commandName}": ${excerpt(reset.stdout)}.`,
    });
  }
  const status = yield* git
    .run(['status', '--porcelain=v1', '--untracked-files=no'], repositoryPath)
    .pipe(Effect.mapError((error) => new ProjectCommandError({ message: error.message })));
  if (status.exitCode !== 0 || status.stdout.trim().length > 0) {
    return yield* new ProjectCommandError({
      message: `The run-owned worktree at ${repositoryPath} was not proven clean at ${targetCommit} after project command "${commandName}".`,
    });
  }
});

export const runGuardedProjectCommand = Effect.fn('runGuardedProjectCommand')(function* (
  options: GuardedProjectCommandOptions,
): Effect.fn.Return<
  GuardedProjectCommandOutcome,
  ProjectCommandError,
  ReadinessGit | ProjectCommandProcess | ProjectEvidenceStore
> {
  const git = yield* ReadinessGit;
  const process = yield* ProjectCommandProcess;
  const evidence = yield* ProjectEvidenceStore;

  const [executable, ...args] = options.command;
  if (executable === undefined) {
    return yield* new ProjectCommandError({
      message: `Project command "${options.name}" is empty.`,
    });
  }

  const snapshotBefore = yield* readSnapshot(git, options.repositoryPath, options.name);
  const started = yield* Clock.currentTimeMillis;
  const attempted = yield* process
    .run({ command: [...options.command], cwd: options.cwd })
    .pipe(Effect.timeout(Duration.millis(options.timeoutMs)), Effect.result);
  const durationMs = Math.max(0, (yield* Clock.currentTimeMillis) - started);

  let timedOut = false;
  let stdout = '';
  let stderr = '';
  let failureDetail = '';
  if (Result.isFailure(attempted)) {
    const failure = attempted.failure;
    if (failure._tag === 'TimeoutError') {
      timedOut = true;
      failureDetail = `timed out after ${options.timeoutMs}ms`;
    } else {
      return yield* new ProjectCommandError({ message: failure.message });
    }
  } else {
    stdout = attempted.success.stdout;
    stderr = attempted.success.stderr;
  }

  const exitCode = Result.isSuccess(attempted) ? attempted.success.exitCode : null;
  const snapshotAfter = yield* readSnapshot(git, options.repositoryPath, options.name);

  let usedEvidence = options.evidenceLedger?.usedBytes ?? 0;
  const evidenceRefusals: Array<OptionalEvidenceRefusal> = [];
  const admit = (kind: OptionalEvidenceRefusal['kind'], incomingBytes: number): boolean => {
    if (options.evidenceLedger === undefined) {
      return true;
    }
    const admission = admitOptionalEvidence({
      history: { maxRunBytes: options.evidenceLedger.maxRunBytes, usedBytes: usedEvidence },
      incomingBytes,
    });
    if (admission.ok) {
      usedEvidence += incomingBytes;
      return true;
    }
    evidenceRefusals.push({ kind, reason: admission.reason });
    return false;
  };

  const dirty =
    snapshotAfter.head !== snapshotBefore.head || snapshotAfter.status !== snapshotBefore.status;
  let mutation: TrackedMutation | null = null;
  let mutationDiff: VerificationLogReference | null = null;
  let reconstructed = false;
  let reconstructionError: string | null = null;
  if (dirty) {
    mutation = yield* captureMutation(
      git,
      options.repositoryPath,
      options.maxDiffBytes,
      options.redactionPatterns,
    );
    const diffPath = join(
      options.evidenceDirectory,
      `${options.name}-mutation-${mutation.diffSha256.slice(0, 16)}.diff`,
    );
    const retainedDiffBytes = new TextEncoder().encode(mutation.diff);
    const diffAdmitted = admit('mutation-diff', retainedDiffBytes.byteLength);
    if (diffAdmitted) {
      yield* evidence
        .write({ path: diffPath, bytes: retainedDiffBytes })
        .pipe(Effect.mapError((error) => new ProjectCommandError({ message: error.message })));
    }
    mutationDiff = {
      path: diffPath,
      sha256: mutation.diffSha256,
      byteLength: mutation.diffByteLength,
      retainedByteLength: diffAdmitted ? retainedDiffBytes.byteLength : 0,
      truncated: diffAdmitted ? mutation.diffTruncated : true,
      redactionCount: mutation.diffRedactionCount,
    };
    if (options.reconstruct) {
      const rebuilt = yield* reconstructTrackedWorktree(
        git,
        options.repositoryPath,
        snapshotBefore.head,
        options.name,
      ).pipe(Effect.result);
      if (Result.isSuccess(rebuilt)) {
        reconstructed = true;
      } else {
        reconstructionError = rebuilt.failure.message;
      }
    }
  }

  const bounded = boundLog(
    `${stdout}\n${stderr}`.trim(),
    options.maxLogBytes,
    options.redactionPatterns,
  );
  const logPath = join(
    options.evidenceDirectory,
    `${options.name}-${bounded.sha256.slice(0, 16)}.log`,
  );
  const retainedLogBytes = new TextEncoder().encode(bounded.retained);
  const logAdmitted = admit('log', retainedLogBytes.byteLength);
  if (logAdmitted) {
    yield* evidence
      .write({ path: logPath, bytes: retainedLogBytes })
      .pipe(Effect.mapError((error) => new ProjectCommandError({ message: error.message })));
  }

  const log: VerificationLogReference = {
    path: logPath,
    sha256: bounded.sha256,
    byteLength: bounded.byteLength,
    retainedByteLength: logAdmitted ? retainedLogBytes.byteLength : 0,
    truncated: logAdmitted ? bounded.truncated : true,
    redactionCount: bounded.redactionCount,
  };

  const detail =
    mutation !== null
      ? excerpt(mutation.diff.length > 0 ? mutation.diff : snapshotAfter.status)
      : excerpt(failureDetail.length > 0 ? failureDetail : `${stdout}\n${stderr}`);

  return {
    kind: options.kind,
    name: options.name,
    executable,
    arguments: args,
    exitCode,
    timedOut,
    durationMs,
    snapshotBefore,
    snapshotAfter,
    mutation,
    mutationDiff,
    reconstructed,
    reconstructionError,
    log,
    evidenceRefusals,
    detail,
  };
});
