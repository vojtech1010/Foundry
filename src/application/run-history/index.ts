import { Context, DateTime, Effect, Result, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  RUN_HISTORY_FILENAME,
  RUN_HISTORY_SCHEMA_VERSION,
  RUN_HISTORY_WITNESS_SCHEMA_VERSION,
  RunEventSchema,
  RunHistoryWitnessSchema,
  encodeRunEventLine,
  encodeRunHistoryWitness,
  sealRunEvent,
  verifyRunHistoryEvents,
} from '../../domain/run-history.js';

import type {
  RunEvent,
  RunEventDraft,
  RunEventEnvelope,
  RunEventOf,
  RunHistoryDerivedState,
  RunHistoryHead,
} from '../../domain/run-history.js';

export class RunHistoryIntegrityError extends Schema.TaggedError<RunHistoryIntegrityError>()(
  'RunHistoryIntegrityError',
  {
    message: Schema.String,
    runId: Schema.String,
    problem: Schema.String,
  },
) {}

export class RunHistoryStorageError extends Schema.TaggedError<RunHistoryStorageError>()(
  'RunHistoryStorageError',
  {
    message: Schema.String,
    runId: Schema.optional(Schema.String),
  },
) {}

export class RunHistoryConflict extends Schema.TaggedError<RunHistoryConflict>()(
  'RunHistoryConflict',
  {
    message: Schema.String,
    runId: Schema.String,
  },
) {}

export type RunHistoryError =
  | RunHistoryIntegrityError
  | RunHistoryStorageError
  | RunHistoryConflict;

export type RunHistoryFileState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-regular-file' }
  | { readonly kind: 'file'; readonly bytes: Uint8Array };

export interface RunHistoryStorageSnapshot {
  readonly stream: RunHistoryFileState;
  readonly witness: RunHistoryFileState;
}

export interface CommitRunHistoryOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly expectedStreamBytes: Uint8Array | null;
  readonly expectedWitnessBytes: Uint8Array | null;
  readonly nextStreamBytes: Uint8Array;
  readonly nextWitnessBytes: Uint8Array;
}

export interface DerivedReportWrite {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ReplaceDerivedReportsOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly expectedStreamBytes: Uint8Array | null;
  readonly expectedWitnessBytes: Uint8Array | null;
  readonly writes: ReadonlyArray<DerivedReportWrite>;
  readonly removals: ReadonlyArray<string>;
}

export class RunHistoryStorage extends Context.Service<
  RunHistoryStorage,
  {
    readonly readHistoryFiles: (
      runDirectory: string,
    ) => Effect.Effect<RunHistoryStorageSnapshot, RunHistoryStorageError>;
    readonly commitHistory: (
      options: CommitRunHistoryOptions,
    ) => Effect.Effect<void, RunHistoryConflict | RunHistoryStorageError>;
    readonly replaceDerivedReports: (
      options: ReplaceDerivedReportsOptions,
    ) => Effect.Effect<void, RunHistoryConflict | RunHistoryStorageError>;
  }
>()('foundry/application/run-history/Storage') {}

export interface ReadVerifiedRunHistoryOptions {
  readonly runDirectory: string;
  readonly runId: string;
  readonly createIfMissing: boolean;
}

export interface VerifiedRunHistory {
  readonly runId: string;
  readonly events: ReadonlyArray<RunEvent>;
  readonly head: RunHistoryHead;
  readonly derived: RunHistoryDerivedState;
  readonly streamBytes: Uint8Array | null;
  readonly witnessBytes: Uint8Array | null;
}

export interface AppendRunEventOptions<Draft extends RunEventDraft, Failure, Requirements> {
  readonly runDirectory: string;
  readonly runId: string;
  readonly createIfMissing: boolean;
  readonly build: (history: VerifiedRunHistory) => Effect.Effect<Draft, Failure, Requirements>;
}

export interface AppendedRunEvent<Draft extends RunEventDraft> {
  readonly event: RunEventOf<Draft>;
  readonly previous: VerifiedRunHistory;
}

const MAX_APPEND_ATTEMPTS = 8;

function integrityProblem(
  runId: string,
  runDirectory: string,
  problem: string,
): RunHistoryIntegrityError {
  const historyPath = join(runDirectory, RUN_HISTORY_FILENAME);
  return new RunHistoryIntegrityError({
    message: `Run "${runId}" canonical history at ${historyPath} cannot be trusted: ${problem}. A person must investigate run integrity before this run continues.`,
    runId,
    problem,
  });
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}

function witnessMatchesHead(
  witness: { readonly revision: number; readonly eventHash: string },
  head: RunHistoryHead,
): boolean {
  return witness.revision === head.revision && witness.eventHash === head.eventHash;
}

export const readVerifiedRunHistory = Effect.fn('readVerifiedRunHistory')(function* (
  options: ReadVerifiedRunHistoryOptions,
): Effect.fn.Return<
  VerifiedRunHistory,
  RunHistoryIntegrityError | RunHistoryStorageError,
  RunHistoryStorage
> {
  const storage = yield* RunHistoryStorage;
  const { runDirectory, runId } = options;
  const snapshot = yield* storage.readHistoryFiles(runDirectory);
  const stream = snapshot.stream;
  const witnessFile = snapshot.witness;

  if (stream.kind === 'missing') {
    if (witnessFile.kind !== 'missing') {
      return yield* integrityProblem(
        runId,
        runDirectory,
        'the history stream is missing while its witness remains, so committed history was truncated',
      );
    }
    if (!options.createIfMissing) {
      return yield* integrityProblem(
        runId,
        runDirectory,
        'no canonical history stream exists for this run',
      );
    }
    return {
      runId,
      events: [],
      head: { revision: 0, eventHash: null },
      derived: {
        state: null,
        checkpoint: null,
        attempts: [],
        cleanupProgress: null,
        sourceFrozen: null,
        guidanceFrozen: null,
        worktreeReady: null,
        roleSessions: [],
        acceptedPlan: null,
        findings: [],
        implementation: null,
        permissionViolations: [],
        verifications: [],
        testerSkips: [],
        validationLimitations: [],
        runtimeLifecycles: [],
      },
      streamBytes: null,
      witnessBytes: null,
    };
  }
  if (stream.kind === 'not-regular-file') {
    return yield* integrityProblem(runId, runDirectory, 'the history stream is not a regular file');
  }
  if (witnessFile.kind === 'missing') {
    return yield* integrityProblem(
      runId,
      runDirectory,
      'the history witness is missing, so truncation cannot be ruled out',
    );
  }
  if (witnessFile.kind === 'not-regular-file') {
    return yield* integrityProblem(
      runId,
      runDirectory,
      'the history witness is not a regular file',
    );
  }

  const witnessText = yield* Effect.try({
    try: () => decodeText(witnessFile.bytes),
    catch: () => integrityProblem(runId, runDirectory, 'the history witness is not valid UTF-8'),
  });
  const witness = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(RunHistoryWitnessSchema),
    { onExcessProperty: 'error' },
  )(witnessText).pipe(
    Effect.mapError(() =>
      integrityProblem(runId, runDirectory, 'the history witness is not a valid record'),
    ),
  );
  if (witness.runId !== runId) {
    return yield* integrityProblem(
      runId,
      runDirectory,
      `the history witness belongs to run "${witness.runId}"`,
    );
  }

  const streamText = yield* Effect.try({
    try: () => decodeText(stream.bytes),
    catch: () => integrityProblem(runId, runDirectory, 'the history stream is not valid UTF-8'),
  });
  if (!streamText.endsWith('\n')) {
    return yield* integrityProblem(
      runId,
      runDirectory,
      'the history stream does not end with a terminal newline',
    );
  }
  const lines = streamText.split('\n');
  lines.pop();
  if (lines.length === 0) {
    return yield* integrityProblem(runId, runDirectory, 'the history stream is empty');
  }

  const events: Array<RunEvent> = [];
  for (const [index, line] of lines.entries()) {
    const event = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(RunEventSchema), {
      onExcessProperty: 'error',
    })(line).pipe(
      Effect.mapError(() =>
        integrityProblem(runId, runDirectory, `history line ${index + 1} is not a valid event`),
      ),
    );
    events.push(event);
  }

  const verification = verifyRunHistoryEvents(events, runId);
  if (!verification.ok) {
    return yield* integrityProblem(runId, runDirectory, verification.problem);
  }
  if (!witnessMatchesHead(witness, verification.head)) {
    return yield* integrityProblem(
      runId,
      runDirectory,
      'the history witness does not match the last accepted revision and hash',
    );
  }

  return {
    runId,
    events,
    head: verification.head,
    derived: verification.derived,
    streamBytes: stream.bytes,
    witnessBytes: witnessFile.bytes,
  };
});

export const appendRunEvent = Effect.fn('appendRunEvent')(function* <
  Draft extends RunEventDraft,
  Failure,
  Requirements,
>(
  options: AppendRunEventOptions<Draft, Failure, Requirements>,
): Effect.fn.Return<
  AppendedRunEvent<Draft>,
  Failure | RunHistoryError,
  Requirements | RunHistoryStorage
> {
  const storage = yield* RunHistoryStorage;
  const { runDirectory, runId } = options;
  for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt += 1) {
    const previous = yield* readVerifiedRunHistory({
      runDirectory,
      runId,
      createIfMissing: options.createIfMissing,
    });
    const draft = yield* options.build(previous);
    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    const envelope: RunEventEnvelope = {
      schemaVersion: RUN_HISTORY_SCHEMA_VERSION,
      runId,
      revision: previous.head.revision + 1,
      eventId: randomUUID(),
      occurredAt,
      previousEventHash: previous.head.eventHash,
    };
    const event = sealRunEvent(envelope, draft);
    const nextStreamBytes = concatBytes(
      previous.streamBytes ?? new Uint8Array(),
      encodeRunEventLine(event),
    );
    const nextWitnessBytes = encodeRunHistoryWitness({
      schemaVersion: RUN_HISTORY_WITNESS_SCHEMA_VERSION,
      runId,
      revision: event.revision,
      eventHash: event.eventHash,
    });

    const committed = yield* storage
      .commitHistory({
        runDirectory,
        runId,
        expectedStreamBytes: previous.streamBytes,
        expectedWitnessBytes: previous.witnessBytes,
        nextStreamBytes,
        nextWitnessBytes,
      })
      .pipe(Effect.result);

    if (Result.isSuccess(committed)) {
      return { event, previous };
    }
    if (committed.failure._tag !== 'RunHistoryConflict') {
      return yield* committed.failure;
    }
  }

  return yield* new RunHistoryConflict({
    message: `Run "${runId}" history is still contended after ${MAX_APPEND_ATTEMPTS} append attempts.`,
    runId,
  });
});
