import { Clock, DateTime, Duration, Effect, Ref, Schema } from 'effect';
import { join } from 'node:path';

import { RUNTIME_KIND, RUNTIME_DATA_POLICY_PRESERVED } from '../../domain/project-runtime.js';
import {
  OwnedProjectProcess,
  resolveCommandVector,
  runGuardedProjectCommand,
} from '../project-commands/index.js';
import { appendRunEvent } from '../run-history/index.js';

import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type { ReadinessGit } from '../readiness/index.js';
import type { ProjectCommandProcess, ProjectEvidenceStore } from '../project-commands/index.js';
import type { RunHistoryStorage } from '../run-history/index.js';
import type {
  RuntimeCleanupDisposition,
  RuntimeLifecycleOutcome,
  RuntimeLifecycleRecord,
  RuntimeStageRecord,
} from '../../domain/project-runtime.js';
import type {
  GuardedProjectCommandOutcome,
  OwnedProcessHandle,
} from '../project-commands/index.js';
import type { RunHistoryError } from '../run-history/index.js';

export class ProjectRuntimeError extends Schema.TaggedError<ProjectRuntimeError>()(
  'ProjectRuntimeError',
  {
    message: Schema.String,
  },
) {}

export interface RunApplicationRuntimeOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly repositoryPath: string;
  readonly configDirectory: string;
  readonly commit: string;
  readonly configuration: ProjectConfiguration;
}

export type ProjectRuntimeResult =
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'prepared'; readonly record: RuntimeLifecycleRecord }
  | { readonly status: 'failed'; readonly record: RuntimeLifecycleRecord };

function isPassing(outcome: GuardedProjectCommandOutcome): boolean {
  return (
    !outcome.timedOut &&
    outcome.exitCode === 0 &&
    outcome.mutation === null &&
    outcome.reconstructionError === null
  );
}

export const runApplicationRuntime = Effect.fn('runApplicationRuntime')(function* (
  options: RunApplicationRuntimeOptions,
): Effect.fn.Return<
  ProjectRuntimeResult,
  ProjectRuntimeError | RunHistoryError,
  | ReadinessGit
  | ProjectCommandProcess
  | ProjectEvidenceStore
  | OwnedProjectProcess
  | RunHistoryStorage
> {
  const profile = options.configuration.runtimeProfile;
  if (profile === null) {
    return {
      status: 'skipped',
      reason:
        'No usable application runtime profile is configured; runtime preparation is omitted.',
    };
  }

  const owned = yield* OwnedProjectProcess;
  const evidenceDirectory = join(options.runDirectory, 'evidence');
  const commandMs = options.configuration.timeouts.commandMs;
  const readinessMs = options.configuration.timeouts.runtimeReadinessMs;
  const cleanupMs = options.configuration.timeouts.cleanupMs;
  const pollMs = options.configuration.timeouts.pollMs;

  const stages = yield* Ref.make<ReadonlyArray<RuntimeStageRecord>>([]);
  const handleRef = yield* Ref.make<OwnedProcessHandle | null>(null);
  const outcomeRef = yield* Ref.make<RuntimeLifecycleOutcome>('failed');
  const cleanupRef = yield* Ref.make<RuntimeCleanupDisposition>('not_owned');
  const readyAtRef = yield* Ref.make<string | null>(null);
  const startedAt = DateTime.formatIso(yield* DateTime.now);

  const recordStage = Effect.fn('runApplicationRuntime.recordStage')(function* (
    name: RuntimeStageRecord['name'],
    stageOutcome: RuntimeStageRecord['outcome'],
    startedMs: number,
    detail: string,
  ): Effect.fn.Return<void> {
    const finishedMs = yield* Clock.currentTimeMillis;
    const stage: RuntimeStageRecord = {
      name,
      outcome: stageOutcome,
      durationMs: Math.max(0, finishedMs - startedMs),
      detail: detail.slice(0, 500),
    };
    yield* Ref.update(stages, (current) => [...current, stage]);
  });

  const runStep = Effect.fn('runApplicationRuntime.runStep')(function* (
    name: string,
    vector: ReadonlyArray<string>,
  ): Effect.fn.Return<
    GuardedProjectCommandOutcome,
    ProjectRuntimeError,
    ReadinessGit | ProjectCommandProcess | ProjectEvidenceStore
  > {
    return yield* runGuardedProjectCommand({
      kind: 'runtime',
      name,
      command: resolveCommandVector(options.configDirectory, vector),
      cwd: options.repositoryPath,
      repositoryPath: options.repositoryPath,
      timeoutMs: commandMs,
      maxLogBytes: options.configuration.artifacts.maxTerminalCaptureBytes,
      maxDiffBytes: options.configuration.artifacts.maxEvidenceBytes,
      redactionPatterns: options.configuration.artifacts.redactionPatterns,
      evidenceDirectory,
      reconstruct: true,
    }).pipe(Effect.mapError((error) => new ProjectRuntimeError({ message: error.message })));
  });

  const prepare = Effect.gen(function* () {
    const resetStart = yield* Clock.currentTimeMillis;
    const reset = yield* runStep('reset', profile.reset);
    if (!isPassing(reset)) {
      yield* recordStage('reset', 'failed', resetStart, reset.detail);
      return;
    }
    yield* recordStage('reset', 'succeeded', resetStart, 'Runtime reset completed.');

    const buildStart = yield* Clock.currentTimeMillis;
    const built = yield* runStep('build', profile.build);
    if (!isPassing(built)) {
      yield* recordStage('build', 'failed', buildStart, built.detail);
      return;
    }
    yield* recordStage('build', 'succeeded', buildStart, 'Application build completed.');

    const startStart = yield* Clock.currentTimeMillis;
    const started = yield* owned
      .start({
        command: resolveCommandVector(options.configDirectory, profile.start),
        cwd: options.repositoryPath,
        maxLogBytes: options.configuration.artifacts.maxTerminalCaptureBytes,
      })
      .pipe(Effect.mapError((error) => new ProjectRuntimeError({ message: error.message })));
    yield* Ref.set(handleRef, started);
    yield* recordStage(
      'start',
      'succeeded',
      startStart,
      `Owned application process ${started.id}.`,
    );

    const readinessStart = yield* Clock.currentTimeMillis;
    const maxAttempts = Math.max(1, Math.ceil(readinessMs / Math.max(1, pollMs)) + 1);
    let ready = false;
    let lastDetail = 'Readiness was never attempted.';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const loaded = yield* runStep('readiness', profile.readiness);
      if (isPassing(loaded)) {
        ready = true;
        break;
      }
      lastDetail = loaded.detail;
      yield* Effect.sleep(Duration.millis(pollMs));
    }
    if (ready) {
      yield* Ref.set(readyAtRef, DateTime.formatIso(yield* DateTime.now));
      yield* Ref.set(outcomeRef, 'ready');
      yield* recordStage(
        'readiness',
        'succeeded',
        readinessStart,
        `Readiness succeeded at ${profile.baseUrl}.`,
      );
    } else {
      yield* recordStage(
        'readiness',
        'timed_out',
        readinessStart,
        `Readiness did not succeed within ${readinessMs}ms. ${lastDetail}`,
      );
    }
  });

  const cleanupRuntime = Effect.gen(function* () {
    const stopStart = yield* Clock.currentTimeMillis;
    const stopped = yield* runStep('stop', profile.stop).pipe(Effect.result);
    if (stopped._tag === 'Success' && isPassing(stopped.success)) {
      yield* recordStage('stop', 'succeeded', stopStart, 'Polite stop request completed.');
    } else {
      const detail = stopped._tag === 'Success' ? stopped.success.detail : stopped.failure.message;
      yield* recordStage('stop', 'failed', stopStart, detail);
    }

    const currentHandle = yield* Ref.get(handleRef);
    if (currentHandle === null) {
      yield* recordStage(
        'cleanup',
        'skipped',
        yield* Clock.currentTimeMillis,
        'No owned process tree was recorded.',
      );
      return;
    }
    const cleanupStart = yield* Clock.currentTimeMillis;
    const terminated = yield* owned
      .terminate({ handle: currentHandle, graceMs: cleanupMs })
      .pipe(Effect.result);
    if (terminated._tag === 'Success') {
      yield* Ref.set(cleanupRef, terminated.success.disposition);
      yield* recordStage('cleanup', 'succeeded', cleanupStart, terminated.success.detail);
    } else {
      yield* Ref.set(cleanupRef, 'failed');
      yield* recordStage('cleanup', 'failed', cleanupStart, terminated.failure.message);
    }
  });

  yield* Effect.ensuring(prepare, cleanupRuntime);

  const outcome = yield* Ref.get(outcomeRef);
  const record: RuntimeLifecycleRecord = {
    repository: options.repositoryPath,
    commit: options.commit,
    baseUrl: profile.baseUrl,
    runtimeKind: RUNTIME_KIND,
    startedAt,
    readyAt: yield* Ref.get(readyAtRef),
    stoppedAt: DateTime.formatIso(yield* DateTime.now),
    outcome,
    cleanup: yield* Ref.get(cleanupRef),
    dataPreserved: RUNTIME_DATA_POLICY_PRESERVED,
    stages: yield* Ref.get(stages),
  };

  yield* appendRunEvent({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
    build: () => Effect.succeed({ type: 'runtime-lifecycle', payload: record } as const),
  });

  return { status: outcome === 'ready' ? 'prepared' : 'failed', record };
});
