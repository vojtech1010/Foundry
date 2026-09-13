import type { RunHistoryDerivedState } from '../../domain/run-history.js';

export type OptionalEvidenceRefusalReason = 'run-evidence-limit-reached';

export type OptionalEvidenceAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: OptionalEvidenceRefusalReason };

export interface EvidenceLedger {
  readonly maxRunBytes: number;
  readonly usedBytes: number;
}

export interface InvalidRedactionPattern {
  readonly pattern: string;
  readonly problem: string;
}

export interface RedactedText {
  readonly text: string;
  readonly redactionCount: number;
}

/**
 * Sum of retained optional-evidence bytes recorded in verified history: the
 * terminal capture and tracked mutation retained for each verification
 * execution. Mandatory history, machine envelopes, and the canonical handoff
 * are never counted because they are never truncated.
 */
export function usedEvidenceBytes(history: RunHistoryDerivedState): number {
  let total = 0;
  for (const report of history.verifications) {
    for (const execution of report.executions) {
      total += execution.log.retainedByteLength;
      if (execution.trackedMutation !== null) {
        total += execution.trackedMutation.retainedByteLength;
      }
    }
  }
  return total;
}

export function evidenceLedger(
  history: RunHistoryDerivedState,
  maxRunBytes: number,
): EvidenceLedger {
  return { maxRunBytes, usedBytes: usedEvidenceBytes(history) };
}

export function admitOptionalEvidence(options: {
  readonly history: EvidenceLedger;
  readonly incomingBytes: number;
}): OptionalEvidenceAdmission {
  const { history, incomingBytes } = options;
  if (incomingBytes <= 0) {
    return { ok: true };
  }
  if (history.usedBytes >= history.maxRunBytes) {
    return { ok: false, reason: 'run-evidence-limit-reached' };
  }
  if (history.usedBytes + incomingBytes > history.maxRunBytes) {
    return { ok: false, reason: 'run-evidence-limit-reached' };
  }
  return { ok: true };
}

export function compileRedactionPattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'gu');
  } catch {
    return null;
  }
}

export function redactText(text: string, patterns: ReadonlyArray<string>): RedactedText {
  let redacted = text;
  let redactionCount = 0;
  for (const pattern of patterns) {
    const expression = compileRedactionPattern(pattern);
    if (expression === null) {
      continue;
    }
    redacted = redacted.replace(expression, () => {
      redactionCount += 1;
      return '[REDACTED]';
    });
  }
  return { text: redacted, redactionCount };
}

export function invalidRedactionPatterns(
  patterns: ReadonlyArray<string>,
): ReadonlyArray<InvalidRedactionPattern> {
  const invalid: Array<InvalidRedactionPattern> = [];
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, 'gu');
    } catch (error) {
      invalid.push({
        pattern,
        problem: error instanceof Error ? error.message : 'not a valid regular expression',
      });
    }
  }
  return invalid;
}
