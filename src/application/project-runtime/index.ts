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

type RuntimePreparationRequirement =
  | ReadinessGit
  | ProjectCommandProcess
  | ProjectEvidenceStore
  | OwnedProjectProcess;

type RuntimeRequirement = RuntimePreparationRequirement | RunHistoryStorage;

function isPassing(outcome: GuardedProjectCommandOutcome): boolean {
  return (
    !outcome.timedOut &&
    outcome.exitCode === 0 &&
    outcome.mutation === null &&
    outcome.reconstructionError === null
  );
}

interface RuntimeSession {
  readonly options: RunApplicationRuntimeOptions;
  readonly baseUrl: string;
  readonly startedAt: string;
  readonly outcome: RuntimeLifecycleOutcome;
  readonly readyAt: string | null;
  readonly stages: Ref.Ref<ReadonlyArray<RuntimeStageRecord>>;
  readonly handle: Ref.Ref<OwnedProcessHandle | null>;
  readonly cleanup: Ref.Ref<RuntimeCleanupDisposition>;
}

type RuntimePreparation =
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'session'; readonly session: RuntimeSession };

function lifecycleRecord(
  session: RuntimeSession,
  stages: ReadonlyArray<RuntimeStageRecord>,
  cleanup: RuntimeCleanupDisposition,
  stoppedAt: string | null,
): RuntimeLifecycleRecord {
  return {
    repository: session.options.repositoryPath,
    commit: session.options.commit,
    baseUrl: session.baseUrl,
    runtimeKind: RUNTIME_KIND,
    startedAt: session.startedAt,
    readyAt: session.readyAt,
    stoppedAt,
    outcome: session.outcome,
    cleanup,
    dataPreserved: RUNTIME_DATA_POLICY_PRESERVED,
    stages,
  };
}

const appendLifecycle = (options: RunApplicationRuntimeOptions, record: RuntimeLifecycleRecord) =>
  appendRunEvent({
    runDirectory: options.runDirectory,
    runId: options.runId,
    createIfMissing: false,
    build: () => Effect.succeed({ type: 'runtime-lifecycle', payload: record } as const),
  });

const prepareRuntimeSession = Effect.fn('prepareRuntimeSession')(function* (
  options: RunApplicationRuntimeOptions,
): Effect.fn.Return<RuntimePreparation, ProjectRuntimeError, RuntimePreparationRequirement> {
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
  const pollMs = options.configuration.timeouts.pollMs;

  const stages = yield* Ref.make<ReadonlyArray<RuntimeStageRecord>>([]);
  const handleRef = yield* Ref.make<OwnedProcessHandle | null>(null);
  const cleanupRef = yield* Ref.make<RuntimeCleanupDisposition>('not_owned');
  const startedAt = DateTime.formatIso(yield* DateTime.now);

  const recordStage = Effect.fn('prepareRuntimeSession.recordStage')(function* (
    name: RuntimeStageRecord['name'],
    stageOutcome: RuntimeStageRecord['outcome'],
    startedMs: number,
    detail: string,
  ): Effect.fn.Return<void> {
    const finishedMs = yield* Clock.currentTimeMillis;
    yield* Ref.update(stages, (current) => [
      ...current,
      {
        name,
        outcome: stageOutcome,
        durationMs: Math.max(0, finishedMs - startedMs),
        detail: detail.slice(0, 500),
      },
    ]);
  });

  const runStep = Effect.fn('prepareRuntimeSession.runStep')(function* (
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

  const session = (outcome: RuntimeLifecycleOutcome, readyAt: string | null): RuntimeSession => ({
    options,
    baseUrl: profile.baseUrl,
    startedAt,
    outcome,
    readyAt,
    stages,
    handle: handleRef,
    cleanup: cleanupRef,
  });

  const resetStart = yield* Clock.currentTimeMillis;
  const reset = yield* runStep('reset', profile.reset);
  if (!isPassing(reset)) {
    yield* recordStage('reset', 'failed', resetStart, reset.detail);
    return { status: 'session', session: session('failed', null) };
  }
  yield* recordStage('reset', 'succeeded', resetStart, 'Runtime reset completed.');

  const buildStart = yield* Clock.currentTimeMillis;
  const built = yield* runStep('build', profile.build);
  if (!isPassing(built)) {
    yield* recordStage('build', 'failed', buildStart, built.detail);
    return { status: 'session', session: session('failed', null) };
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
  yield* recordStage('start', 'succeeded', startStart, `Owned application process ${started.id}.`);

  const readinessStart = yield* Clock.currentTimeMillis;
  const maxAttempts = Math.max(1, Math.ceil(readinessMs / Math.max(1, pollMs)) + 1);
  let lastDetail = 'Readiness was never attempted.';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const loaded = yield* runStep('readiness', profile.readiness);
    if (isPassing(loaded)) {
      const readyAt = DateTime.formatIso(yield* DateTime.now);
      yield* recordStage(
        'readiness',
        'succeeded',
        readinessStart,
        `Readiness succeeded at ${profile.baseUrl}.`,
      );
      return { status: 'session', session: session('ready', readyAt) };
    }
    lastDetail = loaded.detail;
    yield* Effect.sleep(Duration.millis(pollMs));
  }
  yield* recordStage(
    'readiness',
    'timed_out',
    readinessStart,
    `Readiness did not succeed within ${readinessMs}ms. ${lastDetail}`,
  );
  return { status: 'session', session: session('failed', null) };
});

const disposeRuntimeSession = Effect.fn('disposeRuntimeSession')(function* (
  session: RuntimeSession,
): Effect.fn.Return<RuntimeLifecycleRecord, ProjectRuntimeError, RuntimePreparationRequirement> {
  const options = session.options;
  const owned = yield* OwnedProjectProcess;
  const profile = options.configuration.runtimeProfile;
  const cleanupMs = options.configuration.timeouts.cleanupMs;

  const recordStage = Effect.fn('disposeRuntimeSession.recordStage')(function* (
    name: RuntimeStageRecord['name'],
    stageOutcome: RuntimeStageRecord['outcome'],
    startedMs: number,
    detail: string,
  ): Effect.fn.Return<void> {
    const finishedMs = yield* Clock.currentTimeMillis;
    yield* Ref.update(session.stages, (current) => [
      ...current,
      {
        name,
        outcome: stageOutcome,
        durationMs: Math.max(0, finishedMs - startedMs),
        detail: detail.slice(0, 500),
      },
    ]);
  });

  const stopStart = yield* Clock.currentTimeMillis;
  const stopped =
    profile === null
      ? null
      : yield* runGuardedProjectCommand({
          kind: 'runtime',
          name: 'stop',
          command: resolveCommandVector(options.configDirectory, profile.stop),
          cwd: options.repositoryPath,
          repositoryPath: options.repositoryPath,
          timeoutMs: options.configuration.timeouts.commandMs,
          maxLogBytes: options.configuration.artifacts.maxTerminalCaptureBytes,
          maxDiffBytes: options.configuration.artifacts.maxEvidenceBytes,
          redactionPatterns: options.configuration.artifacts.redactionPatterns,
          evidenceDirectory: join(options.runDirectory, 'evidence'),
          reconstruct: true,
        }).pipe(Effect.result);
  if (stopped !== null && stopped._tag === 'Success' && isPassing(stopped.success)) {
    yield* recordStage('stop', 'succeeded', stopStart, 'Polite stop request completed.');
  } else if (stopped !== null) {
    const detail = stopped._tag === 'Success' ? stopped.success.detail : stopped.failure.message;
    yield* recordStage('stop', 'failed', stopStart, detail);
  }

  const currentHandle = yield* Ref.get(session.handle);
  if (currentHandle === null) {
    yield* recordStage(
      'cleanup',
      'skipped',
      yield* Clock.currentTimeMillis,
      'No owned process tree was recorded.',
    );
    return lifecycleRecord(
      session,
      yield* Ref.get(session.stages),
      yield* Ref.get(session.cleanup),
      DateTime.formatIso(yield* DateTime.now),
    );
  }
  const cleanupStart = yield* Clock.currentTimeMillis;
  const terminated = yield* owned
    .terminate({ handle: currentHandle, graceMs: cleanupMs })
    .pipe(Effect.result);
  if (terminated._tag === 'Success') {
    yield* Ref.set(session.cleanup, terminated.success.disposition);
    yield* recordStage('cleanup', 'succeeded', cleanupStart, terminated.success.detail);
  } else {
    yield* Ref.set(session.cleanup, 'failed');
    yield* recordStage('cleanup', 'failed', cleanupStart, terminated.failure.message);
  }

  return lifecycleRecord(
    session,
    yield* Ref.get(session.stages),
    yield* Ref.get(session.cleanup),
    DateTime.formatIso(yield* DateTime.now),
  );
});

export const runApplicationRuntime = Effect.fn('runApplicationRuntime')(function* (
  options: RunApplicationRuntimeOptions,
): Effect.fn.Return<
  ProjectRuntimeResult,
  ProjectRuntimeError | RunHistoryError,
  RuntimeRequirement
> {
  const prepared = yield* prepareRuntimeSession(options);
  if (prepared.status === 'skipped') {
    return { status: 'skipped', reason: prepared.reason };
  }
  const record = yield* disposeRuntimeSession(prepared.session);
  yield* appendLifecycle(options, record);
  return record.outcome === 'ready' ? { status: 'prepared', record } : { status: 'failed', record };
});

export interface HeldApplicationRuntime {
  readonly baseUrl: string;
  readonly record: RuntimeLifecycleRecord;
  readonly dispose: Effect.Effect<
    RuntimeLifecycleRecord,
    ProjectRuntimeError | RunHistoryError,
    RuntimePreparationRequirement | RunHistoryStorage
  >;
}

export type PrepareAndHoldResult =
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly record: RuntimeLifecycleRecord }
  | { readonly status: 'prepared'; readonly runtime: HeldApplicationRuntime };

/**
 * Prepares the owned application runtime and keeps it alive for the caller. The
 * readiness lifecycle record is appended immediately so durable routing can see
 * a prepared origin, while stop and cleanup remain Foundry-owned and are
 * appended by `dispose` even on failure or interruption. `runApplicationRuntime`
 * stays the immediate-dispose convenience form with a single record.
 */
export const prepareAndHoldApplicationRuntime = Effect.fn('prepareAndHoldApplicationRuntime')(
  function* (
    options: RunApplicationRuntimeOptions,
  ): Effect.fn.Return<
    PrepareAndHoldResult,
    ProjectRuntimeError | RunHistoryError,
    RuntimeRequirement
  > {
    const prepared = yield* prepareRuntimeSession(options);
    if (prepared.status === 'skipped') {
      return { status: 'skipped', reason: prepared.reason };
    }
    if (prepared.session.outcome !== 'ready') {
      const record = yield* disposeRuntimeSession(prepared.session);
      yield* appendLifecycle(options, record);
      return { status: 'failed', record };
    }
    const readyRecord = lifecycleRecord(
      prepared.session,
      yield* Ref.get(prepared.session.stages),
      'not_owned',
      null,
    );
    yield* appendLifecycle(options, readyRecord);
    const dispose = Effect.fn('prepareAndHoldApplicationRuntime.dispose')(function* () {
      const final = yield* disposeRuntimeSession(prepared.session);
      yield* appendLifecycle(options, final);
      return final;
    });
    return {
      status: 'prepared',
      runtime: {
        baseUrl: prepared.session.baseUrl,
        record: readyRecord,
        dispose: dispose(),
      },
    };
  },
);
