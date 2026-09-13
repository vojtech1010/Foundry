import { createHash } from 'node:crypto';
import { Schema } from 'effect';

import { VERIFICATION_COMMANDS } from './project-configuration.js';
import { Sha256Hex } from './run-identity.js';

export const VERIFICATION_GATES = VERIFICATION_COMMANDS;

export type VerificationGate = (typeof VERIFICATION_GATES)[number];

export const VERIFICATION_GATE_KINDS = ['bootstrap', 'gate'] as const;

export type VerificationGateKind = (typeof VERIFICATION_GATE_KINDS)[number];

export const VERIFICATION_RESULTS = ['passed', 'failed'] as const;

export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const VerificationGateNameSchema = Schema.Literals(VERIFICATION_GATES);

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const VerificationLogReferenceSchema = Schema.Struct({
  path: Schema.NonEmptyString,
  sha256: Sha256Hex,
  byteLength: NonNegativeInt,
  retainedByteLength: NonNegativeInt,
  truncated: Schema.Boolean,
  redactionCount: NonNegativeInt,
});

export type VerificationLogReference = (typeof VerificationLogReferenceSchema)['Type'];

export const VerificationExecutionSchema = Schema.Struct({
  kind: Schema.Literals(VERIFICATION_GATE_KINDS),
  name: Schema.NonEmptyString,
  executable: Schema.NonEmptyString,
  arguments: Schema.Array(Schema.String),
  expectedExitCode: Schema.Int,
  actualExitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  durationMs: NonNegativeInt,
  log: VerificationLogReferenceSchema,
});

export type VerificationExecution = (typeof VerificationExecutionSchema)['Type'];

export const ProjectVerificationReportSchema = Schema.Struct({
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  repository: Schema.NonEmptyString,
  commit: Schema.NonEmptyString,
  profileHash: Sha256Hex,
  commandMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  executions: Schema.Array(VerificationExecutionSchema),
  result: Schema.Literals(VERIFICATION_RESULTS),
});

export type ProjectVerificationReport = (typeof ProjectVerificationReportSchema)['Type'];

export interface VerificationCommandProfileEntry {
  readonly name: string;
  readonly command: ReadonlyArray<string>;
}

export interface VerificationCommandProfile {
  readonly commandMs: number;
  readonly bootstrap: VerificationCommandProfileEntry | null;
  readonly gates: ReadonlyArray<VerificationCommandProfileEntry>;
}

export function verificationProfileHash(profile: VerificationCommandProfile): string {
  const canonical = {
    commandMs: profile.commandMs,
    bootstrap:
      profile.bootstrap === null
        ? null
        : { name: profile.bootstrap.name, command: [...profile.bootstrap.command] },
    gates: profile.gates.map((entry) => ({ name: entry.name, command: [...entry.command] })),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export function bootstrapExecution(
  report: ProjectVerificationReport,
): VerificationExecution | null {
  return report.executions.find((execution) => execution.kind === 'bootstrap') ?? null;
}

export function gateExecutions(
  report: ProjectVerificationReport,
): ReadonlyArray<VerificationExecution> {
  return report.executions.filter((execution) => execution.kind === 'gate');
}
