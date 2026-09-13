import { Result, Schema } from 'effect';

export const TESTER_CONTROL_SCHEMA_VERSION = 1 as const;

export const TESTER_TURN_OUTCOMES = ['observed', 'retry_required', 'blocked'] as const;

export type TesterTurnOutcome = (typeof TESTER_TURN_OUTCOMES)[number];

/**
 * Closed Tester control envelope. Tester reports observations and limitations in
 * its Markdown narrative; the envelope deliberately carries no pass/fail verdict
 * and no field that could grant application-data mutation authority.
 */
export const TesterTurnControlSchema = Schema.Struct({
  schemaVersion: Schema.Literal(TESTER_CONTROL_SCHEMA_VERSION),
  outcome: Schema.Literals(TESTER_TURN_OUTCOMES),
});

export type TesterTurnControl = (typeof TesterTurnControlSchema)['Type'];

export type TesterControlDecoding =
  | { readonly ok: true; readonly control: TesterTurnControl }
  | { readonly ok: false; readonly problem: string };

const DECODE_OPTIONS = { onExcessProperty: 'error' } as const;

export function decodeTesterTurnControl(input: Schema.Json): TesterControlDecoding {
  const result = Schema.decodeUnknownResult(TesterTurnControlSchema, DECODE_OPTIONS)(input);
  if (Result.isFailure(result)) {
    return { ok: false, problem: result.failure.message };
  }
  return { ok: true, control: result.success };
}
