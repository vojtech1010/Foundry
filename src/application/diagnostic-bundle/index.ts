import { Effect, Schema } from 'effect';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

import {
  DIAGNOSTIC_BUNDLE_MANIFEST_FILENAME,
  DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
} from '../../domain/diagnostic-bundle.js';
import { RUN_STORAGE_DIRECTORY_NAME } from '../../domain/readiness.js';
import {
  REQUEST_NORMALIZED_FILENAME,
  REQUEST_ORIGINAL_FILENAME,
} from '../../domain/run-identity.js';
import { RUN_HISTORY_FILENAME } from '../../domain/run-history.js';
import { isPathInside } from '../../domain/run-locations.js';
import { redactText } from '../evidence-limits/index.js';
import { buildRunInspectReport } from '../inspect/index.js';
import { ReadinessFiles } from '../readiness/index.js';
import { readVerifiedRunHistory } from '../run-history/index.js';
import { RunIdentityStore, resolveRunContext } from '../run-identity/index.js';

import type {
  DiagnosticBundleEntry,
  DiagnosticBundleEntrySource,
  DiagnosticBundleManifest,
  DiagnosticBundleReport,
} from '../../domain/diagnostic-bundle.js';
import type { ReadinessError } from '../readiness/index.js';
import type {
  RunHistoryConflict,
  RunHistoryIntegrityError,
  RunHistoryStorageError,
} from '../run-history/index.js';
import type { InvalidRunRequest, RunIdentityStorageError } from '../run-identity/index.js';
import type { RunHistoryStorage } from '../run-history/index.js';

export class DiagnosticBundleRefused extends Schema.TaggedError<DiagnosticBundleRefused>()(
  'DiagnosticBundleRefused',
  {
    message: Schema.String,
    runId: Schema.optional(Schema.String),
  },
) {}

export type CreateDiagnosticBundleError =
  | DiagnosticBundleRefused
  | InvalidRunRequest
  | ReadinessError
  | RunIdentityStorageError
  | RunHistoryIntegrityError
  | RunHistoryStorageError
  | RunHistoryConflict;

export type {
  DiagnosticBundleEntry,
  DiagnosticBundleEntrySource,
  DiagnosticBundleManifest,
  DiagnosticBundleReport,
} from '../../domain/diagnostic-bundle.js';

export interface CreateDiagnosticBundleOptions {
  readonly configArg: string;
  readonly cwd: string;
  readonly runId: string;
  readonly output: string;
}

interface RawEntry {
  readonly path: string;
  readonly source: DiagnosticBundleEntrySource;
  readonly text: string;
  readonly maxBytes: number;
}

interface BoundedEntry {
  readonly bytes: Uint8Array;
  readonly entry: DiagnosticBundleEntry;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/**
 * Applies the shared OBJ-042 pipeline to one entry: configured redaction
 * patterns run first, then the redacted bytes are bounded. The manifest records
 * the retained size, the pre-bound size, the hash of the retained bytes, the
 * redaction count, and whether bounding cut the entry short.
 */
function boundEntry(entry: RawEntry, patterns: ReadonlyArray<string>): BoundedEntry {
  const { text, redactionCount } = redactText(entry.text, patterns);
  const fullBytes = new TextEncoder().encode(text);
  const truncated = fullBytes.byteLength > entry.maxBytes;
  const retainedBytes = truncated ? fullBytes.slice(0, entry.maxBytes) : fullBytes;
  return {
    bytes: retainedBytes,
    entry: {
      path: entry.path,
      source: entry.source,
      byteLength: retainedBytes.byteLength,
      originalByteLength: fullBytes.byteLength,
      sha256: sha256Hex(retainedBytes),
      redactionCount,
      truncated,
    },
  };
}

/**
 * Builds a bounded, redacted support snapshot of one run. The snapshot is
 * derived only from the run's verified history and retained bounded artifacts;
 * it never writes to run storage or derives state from file presence. The
 * destination must be new or empty and outside the live `.agent` storage root,
 * and nothing is written until that validation succeeds.
 */
export const createDiagnosticBundle = Effect.fn('createDiagnosticBundle')(function* (
  options: CreateDiagnosticBundleOptions,
): Effect.fn.Return<
  DiagnosticBundleReport,
  CreateDiagnosticBundleError,
  ReadinessFiles | RunHistoryStorage | RunIdentityStore
> {
  const files = yield* ReadinessFiles;
  const store = yield* RunIdentityStore;

  const { configuration, runDirectory } = yield* resolveRunContext({
    configArg: options.configArg,
    cwd: options.cwd,
    runId: options.runId,
  });

  const destination = resolve(options.cwd, options.output);
  const storageRoot = join(configuration.targetRepository, RUN_STORAGE_DIRECTORY_NAME);
  if (resolve(destination) === resolve(storageRoot) || isPathInside(storageRoot, destination)) {
    return yield* new DiagnosticBundleRefused({
      message: `Diagnostic bundle destination ${destination} is inside live run storage ${storageRoot}; choose a new or empty directory outside .agent.`,
      runId: options.runId,
    });
  }
  const destinationStatus = yield* files.statPath(destination);
  if (destinationStatus.exists && !destinationStatus.isDirectory) {
    return yield* new DiagnosticBundleRefused({
      message: `Diagnostic bundle destination ${destination} is not a directory.`,
      runId: options.runId,
    });
  }
  if (destinationStatus.exists) {
    const existing = yield* store.readDirectory(destination);
    if (existing.length > 0) {
      return yield* new DiagnosticBundleRefused({
        message: `Diagnostic bundle destination ${destination} is not empty; choose a new or empty directory.`,
        runId: options.runId,
      });
    }
  }

  const history = yield* readVerifiedRunHistory({
    runDirectory,
    runId: options.runId,
    createIfMissing: false,
  });
  const inspectReport = buildRunInspectReport({ runDirectory, history });

  const artifacts = configuration.artifacts;
  const patterns = artifacts.redactionPatterns;
  const readings: Array<RawEntry> = [];
  const readOptional = Effect.fn('diagnosticBundle.readOptional')(function* (
    absolutePath: string,
    path: string,
    source: DiagnosticBundleEntrySource,
    maxBytes: number,
  ): Effect.fn.Return<void, ReadinessError> {
    const status = yield* files.statPath(absolutePath);
    if (!status.exists || status.isDirectory) {
      return;
    }
    const text = yield* files.readFile(absolutePath);
    readings.push({ path, source, text, maxBytes });
  });

  yield* readOptional(
    join(runDirectory, REQUEST_ORIGINAL_FILENAME),
    'request.md',
    'request',
    artifacts.maxRequestBytes,
  );
  yield* readOptional(
    join(runDirectory, REQUEST_NORMALIZED_FILENAME),
    'request.normalized.md',
    'request-normalized',
    artifacts.maxRequestBytes,
  );
  yield* readOptional(
    join(runDirectory, RUN_HISTORY_FILENAME),
    'run-history/events.jsonl',
    'run-history',
    artifacts.maxRunBytes,
  );
  readings.push({
    path: 'inspect.json',
    source: 'inspect-report',
    text: `${JSON.stringify(inspectReport, null, 2)}\n`,
    maxBytes: artifacts.maxRunBytes,
  });

  const usedPaths = new Set(readings.map((reading) => reading.path));
  for (const report of history.derived.verifications) {
    for (const execution of report.executions) {
      const candidates: ReadonlyArray<{
        readonly absolutePath: string;
        readonly source: DiagnosticBundleEntrySource;
      }> = [
        { absolutePath: execution.log.path, source: 'verification-log' },
        ...(execution.trackedMutation === null
          ? []
          : [
              {
                absolutePath: execution.trackedMutation.diff.path,
                source: 'tracked-mutation' as const,
              },
            ]),
      ];
      for (const candidate of candidates) {
        if (!isPathInside(runDirectory, candidate.absolutePath)) {
          continue;
        }
        const status = yield* files.statPath(candidate.absolutePath);
        if (!status.exists || status.isDirectory) {
          continue;
        }
        const text = yield* files.readFile(candidate.absolutePath);
        const name = basename(candidate.absolutePath);
        let bundlePath = `evidence/${name}`;
        let suffix = 2;
        while (usedPaths.has(bundlePath)) {
          bundlePath = `evidence/${suffix}-${name}`;
          suffix += 1;
        }
        usedPaths.add(bundlePath);
        readings.push({
          path: bundlePath,
          source: candidate.source,
          text,
          maxBytes: artifacts.maxEvidenceBytes,
        });
      }
    }
  }

  const bounded = readings.map((reading) => boundEntry(reading, patterns));
  const entries = bounded.map((entry) => entry.entry);
  const totalByteLength = entries.reduce((total, entry) => total + entry.byteLength, 0);
  const manifestPath = join(destination, DIAGNOSTIC_BUNDLE_MANIFEST_FILENAME);

  for (const entry of bounded) {
    const absolutePath = join(destination, ...entry.entry.path.split('/'));
    yield* store.ensureParentDirectory(dirname(absolutePath));
    yield* store.writeFileBytes(absolutePath, entry.bytes);
  }

  const manifest: DiagnosticBundleManifest = {
    schemaVersion: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    runId: options.runId,
    destination,
    entryCount: entries.length,
    totalByteLength,
    entries,
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  yield* store.ensureParentDirectory(dirname(manifestPath));
  yield* store.writeFileBytes(manifestPath, manifestBytes);

  return {
    runId: options.runId,
    destination,
    manifestPath,
    manifest,
  } satisfies DiagnosticBundleReport;
});
