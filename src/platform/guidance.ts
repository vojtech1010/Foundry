import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { Effect, Layer } from 'effect';

import {
  GuidanceGit,
  GuidanceSnapshotRejected,
  GuidanceSnapshotStore,
  GuidanceStorageError,
} from '../application/guidance/index.js';
import { writeFileAtomically } from './atomic-file.js';

import type {
  GuidanceCommitEntryObservation,
  GuidanceFileStatus,
  ListCommitPathsOptions,
  ReadCommitEntryOptions,
} from '../application/guidance/index.js';

interface GitBufferOutcome {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number;
  readonly spawnFailed: boolean;
}

function bound(text: string): string {
  return text.trim().replaceAll(/\s+/gu, ' ').trim().slice(0, 400);
}

function boundCause(cause: unknown): string {
  return String(cause).replaceAll(/\s+/gu, ' ').trim().slice(0, 500);
}

function runGit(args: ReadonlyArray<string>, cwd: string): GitBufferOutcome {
  const result = spawnSync('git', [...args], { cwd });
  return {
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: result.stderr?.toString('utf8') ?? '',
    exitCode: result.status ?? 1,
    spawnFailed: result.error !== undefined,
  };
}

function readFailure(
  runId: string,
  description: string,
  cwd: string,
  outcome: GitBufferOutcome,
): GuidanceSnapshotRejected {
  const detail = outcome.spawnFailed
    ? `Git ${description} could not run in ${cwd}: ${bound(outcome.stderr)}`
    : `Git ${description} failed in ${cwd} with exit code ${outcome.exitCode}: ${bound(outcome.stderr)}`;
  return new GuidanceSnapshotRejected({
    message: `Run "${runId}" cannot read frozen project guidance: ${detail}.`,
    problem: 'guidance-git-read-failed',
    runId,
  });
}

interface ParsedTreeEntry {
  readonly mode: string;
  readonly objectType: string;
  readonly path: string;
}

function parseTreeEntry(entry: string): ParsedTreeEntry | null {
  const tabIndex = entry.indexOf('\t');
  if (tabIndex === -1) {
    return null;
  }
  const [mode, objectType] = entry.slice(0, tabIndex).split(' ');
  if (mode === undefined || objectType === undefined) {
    return null;
  }
  return { mode, objectType, path: entry.slice(tabIndex + 1) };
}

const listCommitPaths = Effect.fn('guidanceGit.listCommitPaths')(function* (
  options: ListCommitPathsOptions,
): Effect.fn.Return<ReadonlyArray<string>, GuidanceSnapshotRejected> {
  const outcome = yield* Effect.sync(() =>
    runGit(['ls-tree', '-r', '-z', '--name-only', options.commit], options.repositoryRoot),
  );
  if (outcome.spawnFailed || outcome.exitCode !== 0) {
    return yield* readFailure(
      options.runId,
      `ls-tree ${options.commit}`,
      options.repositoryRoot,
      outcome,
    );
  }
  return outcome.stdout
    .toString('utf8')
    .split('\u0000')
    .filter((entry) => entry.length > 0);
});

const readCommitEntry = Effect.fn('guidanceGit.readCommitEntry')(function* (
  options: ReadCommitEntryOptions,
): Effect.fn.Return<GuidanceCommitEntryObservation, GuidanceSnapshotRejected> {
  const treeOutcome = yield* Effect.sync(() =>
    runGit(['ls-tree', '-z', options.commit, '--', options.path], options.repositoryRoot),
  );
  if (treeOutcome.spawnFailed || treeOutcome.exitCode !== 0) {
    return yield* readFailure(
      options.runId,
      `ls-tree ${options.commit} -- ${options.path}`,
      options.repositoryRoot,
      treeOutcome,
    );
  }
  const entries = treeOutcome.stdout
    .toString('utf8')
    .split('\u0000')
    .filter((entry) => entry.length > 0);
  const first = entries[0];
  if (first === undefined) {
    return { kind: 'missing' };
  }
  const parsed = parseTreeEntry(first);
  if (parsed === null) {
    return yield* new GuidanceSnapshotRejected({
      message: `Run "${options.runId}" cannot read frozen project guidance: Git returned an unreadable entry for "${options.path}".`,
      problem: 'guidance-git-read-failed',
      runId: options.runId,
      path: options.path,
    });
  }
  if (parsed.objectType !== 'blob' || (parsed.mode !== '100644' && parsed.mode !== '100755')) {
    return { kind: 'not-regular', mode: parsed.mode, objectType: parsed.objectType };
  }
  const blobOutcome = yield* Effect.sync(() =>
    runGit(['cat-file', 'blob', `${options.commit}:${options.path}`], options.repositoryRoot),
  );
  if (blobOutcome.spawnFailed || blobOutcome.exitCode !== 0) {
    return yield* readFailure(
      options.runId,
      `cat-file blob ${options.commit}:${options.path}`,
      options.repositoryRoot,
      blobOutcome,
    );
  }
  return { kind: 'regular', mode: parsed.mode, bytes: new Uint8Array(blobOutcome.stdout) };
});

const statPath = Effect.fn('guidanceStore.statPath')(function* (
  path: string,
): Effect.fn.Return<GuidanceFileStatus, GuidanceStorageError> {
  const probed = yield* Effect.try({
    try: () => statSync(path),
    catch: () => 'unavailable' as const,
  }).pipe(Effect.orElseSucceed(() => undefined));
  if (probed === undefined) {
    return { exists: false, isRegularFile: false };
  }
  return { exists: true, isRegularFile: probed.isFile() };
});

const readFileBytes = Effect.fn('guidanceStore.readFileBytes')(function* (
  path: string,
): Effect.fn.Return<Uint8Array, GuidanceStorageError> {
  return yield* Effect.try({
    try: () => new Uint8Array(readFileSync(path)),
    catch: (cause) =>
      new GuidanceStorageError({
        message: `Cannot read retained guidance file at ${path}: ${boundCause(cause)}.`,
      }),
  });
});

const ensureParentDirectory = Effect.fn('guidanceStore.ensureParentDirectory')(function* (
  path: string,
): Effect.fn.Return<void, GuidanceStorageError> {
  yield* Effect.try({
    try: () => {
      mkdirSync(path, { recursive: true });
    },
    catch: (cause) =>
      new GuidanceStorageError({
        message: `Cannot prepare guidance storage at ${path}: ${boundCause(cause)}.`,
      }),
  });
});

const writeFileBytes = Effect.fn('guidanceStore.writeFileBytes')(function* (
  path: string,
  bytes: Uint8Array,
): Effect.fn.Return<void, GuidanceStorageError> {
  yield* Effect.try({
    try: () => {
      writeFileAtomically(path, bytes);
    },
    catch: (cause) =>
      new GuidanceStorageError({
        message: `Cannot write retained guidance file at ${path}: ${boundCause(cause)}.`,
      }),
  });
});

export const GuidanceGitLive: Layer.Layer<GuidanceGit> = Layer.succeed(
  GuidanceGit,
  GuidanceGit.of({ listCommitPaths, readCommitEntry }),
);

export const GuidanceSnapshotStoreLive: Layer.Layer<GuidanceSnapshotStore> = Layer.succeed(
  GuidanceSnapshotStore,
  GuidanceSnapshotStore.of({
    statPath,
    readFileBytes,
    ensureParentDirectory,
    writeFileBytes,
  }),
);

export const GuidanceLive: Layer.Layer<GuidanceGit | GuidanceSnapshotStore> = Layer.mergeAll(
  GuidanceGitLive,
  GuidanceSnapshotStoreLive,
);
