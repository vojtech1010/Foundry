import { Schema } from 'effect';

export const OPERATOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const OPERATOR_ID_MIN_LENGTH = 1 as const;

export const OPERATOR_ID_MAX_LENGTH = 64 as const;

export const Identifier = Schema.String.check(
  Schema.isMinLength(OPERATOR_ID_MIN_LENGTH),
  Schema.isMaxLength(OPERATOR_ID_MAX_LENGTH),
  Schema.isPattern(OPERATOR_ID_PATTERN),
);

export type OperatorId = (typeof Identifier)['Type'];

export const REQUEST_IDENTITY_SCHEMA_VERSION = 1 as const;

export const REQUEST_ORIGINAL_FILENAME = 'request.md' as const;

export const REQUEST_NORMALIZED_FILENAME = 'request.normalized.md' as const;

export const REQUEST_IDENTITY_FILENAME = 'request-identity.json' as const;

const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export const Sha256Hex = Schema.String.check(Schema.isPattern(HEX_SHA256_PATTERN));

export function normalizeRequestPromptText(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export const RequestIdentityDocumentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(REQUEST_IDENTITY_SCHEMA_VERSION),
  runId: Identifier,
  taskId: Identifier,
  sourceRequestPath: Schema.NonEmptyString,
  originalByteLength: Schema.Natural,
  originalContentHash: Sha256Hex,
  normalizedByteLength: Schema.Natural,
  normalizedPromptHash: Sha256Hex,
});

export type RequestIdentityDocument = (typeof RequestIdentityDocumentSchema)['Type'];
