import { createHash } from 'node:crypto';
import { Schema } from 'effect';

import { GitCommitId } from './run-locations.js';
import { Identifier, Sha256Hex } from './run-identity.js';

export const GUIDANCE_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const GUIDANCE_MANIFEST_FILENAME = 'guidance-manifest.json' as const;

export const GUIDANCE_DIRECTORY_NAME = 'guidance' as const;

export const GUIDANCE_AGENTS_FILENAME = 'AGENTS.md' as const;

export const GUIDANCE_EXCLUDED_DIRECTORY_NAMES = ['.git', '.agent'] as const;

export const GUIDANCE_VERIFICATION_STATUSES = ['verified'] as const;

export type GuidanceVerificationStatus = (typeof GUIDANCE_VERIFICATION_STATUSES)[number];

export const GuidanceSnapshotFileSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  byteLength: Schema.Natural,
  contentHash: Sha256Hex,
  retainedPath: Schema.NonEmptyString,
});

export type GuidanceSnapshotFile = (typeof GuidanceSnapshotFileSchema)['Type'];

export const GuidanceSnapshotManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(GUIDANCE_SNAPSHOT_SCHEMA_VERSION),
  runId: Identifier,
  sourceCommit: GitCommitId,
  aggregateHash: Sha256Hex,
  files: Schema.Array(GuidanceSnapshotFileSchema),
});

export type GuidanceSnapshotManifest = (typeof GuidanceSnapshotManifestSchema)['Type'];

export function guidancePathSegments(path: string): ReadonlyArray<string> | null {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\')) {
    return null;
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      return null;
    }
  }
  return segments;
}

export function isSafeGuidancePath(path: string): boolean {
  return guidancePathSegments(path) !== null;
}

export function isGuidanceAgentsPath(path: string): boolean {
  const segments = guidancePathSegments(path);
  if (segments === null) {
    return false;
  }
  return segments[segments.length - 1] === GUIDANCE_AGENTS_FILENAME;
}

export function guidanceDirectoryOf(path: string): string | null {
  const segments = guidancePathSegments(path);
  if (segments === null || segments.length < 2) {
    return null;
  }
  return segments.slice(0, -1).join('/');
}

export function isExcludedGuidancePath(path: string): boolean {
  const segments = guidancePathSegments(path);
  if (segments === null) {
    return true;
  }
  return segments.some((segment) =>
    GUIDANCE_EXCLUDED_DIRECTORY_NAMES.some((excluded) => excluded === segment),
  );
}

export function retainedPathOfGuidancePath(path: string): string {
  return `${GUIDANCE_DIRECTORY_NAME}/${path}`;
}

export function compareGuidancePathsByDepth(left: string, right: string): number {
  const leftDepth = left.split('/').length;
  const rightDepth = right.split('/').length;
  if (leftDepth !== rightDepth) {
    return leftDepth - rightDepth;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortGuidanceSnapshotFiles(
  files: ReadonlyArray<GuidanceSnapshotFile>,
): ReadonlyArray<GuidanceSnapshotFile> {
  return [...files].sort((left, right) => compareGuidancePathsByDepth(left.path, right.path));
}

export function guidanceSnapshotFingerprint(files: ReadonlyArray<GuidanceSnapshotFile>): string {
  return files
    .map(
      (file) =>
        `${file.path}\u0000${file.byteLength}\u0000${file.contentHash}\u0000${file.retainedPath}\n`,
    )
    .join('');
}

export function computeGuidanceAggregateHash(
  sourceCommit: string,
  files: ReadonlyArray<GuidanceSnapshotFile>,
): string {
  return createHash('sha256')
    .update(`${sourceCommit}\n${guidanceSnapshotFingerprint(files)}`, 'utf8')
    .digest('hex');
}

export function computeGuidanceContentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
