import { Schema } from 'effect';

export const DIAGNOSTIC_BUNDLE_SCHEMA_VERSION = 1 as const;

export const DIAGNOSTIC_BUNDLE_MANIFEST_FILENAME = 'manifest.json' as const;

/**
 * Where one bundle entry came from. The set is closed so a manifest never
 * claims a source the snapshot cannot actually derive from verified history or
 * retained, bounded artifacts.
 */
export const DIAGNOSTIC_BUNDLE_ENTRY_SOURCES = [
  'run-history',
  'request',
  'request-normalized',
  'inspect-report',
  'verification-log',
  'tracked-mutation',
] as const;

export type DiagnosticBundleEntrySource = (typeof DIAGNOSTIC_BUNDLE_ENTRY_SOURCES)[number];

/**
 * One included entry. `byteLength` is the retained (possibly truncated) size
 * actually written into the bundle, `originalByteLength` is the size after
 * redaction but before bounding, and `sha256` hashes the retained bytes so the
 * manifest identifies the content in the bundle rather than a claim about it.
 */
export const DiagnosticBundleEntrySchema = Schema.Struct({
  path: Schema.NonEmptyString,
  source: Schema.Literals(DIAGNOSTIC_BUNDLE_ENTRY_SOURCES),
  byteLength: Schema.Natural,
  originalByteLength: Schema.Natural,
  sha256: Schema.NonEmptyString,
  redactionCount: Schema.Natural,
  truncated: Schema.Boolean,
});

export type DiagnosticBundleEntry = (typeof DiagnosticBundleEntrySchema)['Type'];

export const DiagnosticBundleManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(DIAGNOSTIC_BUNDLE_SCHEMA_VERSION),
  runId: Schema.NonEmptyString,
  destination: Schema.NonEmptyString,
  entryCount: Schema.Natural,
  totalByteLength: Schema.Natural,
  entries: Schema.Array(DiagnosticBundleEntrySchema),
});

export type DiagnosticBundleManifest = (typeof DiagnosticBundleManifestSchema)['Type'];

export const DiagnosticBundleReportSchema = Schema.Struct({
  runId: Schema.NonEmptyString,
  destination: Schema.NonEmptyString,
  manifestPath: Schema.NonEmptyString,
  manifest: DiagnosticBundleManifestSchema,
});

export type DiagnosticBundleReport = (typeof DiagnosticBundleReportSchema)['Type'];
