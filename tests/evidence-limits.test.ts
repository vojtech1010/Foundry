import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';

import {
  admitOptionalEvidence,
  evidenceLedger,
  invalidRedactionPatterns,
  redactText,
  usedEvidenceBytes,
} from '../src/application/evidence-limits/index.js';
import { RunEventSchema, sealRunEvent } from '../src/domain/run-history.js';

import type { RunEventEnvelope, RunHistoryDerivedState } from '../src/domain/run-history.js';
import type { VerificationLogReference } from '../src/domain/project-verification.js';

const SHA = 'a'.repeat(64);

function logReference(retainedByteLength: number): VerificationLogReference {
  return {
    path: '/run/evidence/lint.log',
    sha256: SHA,
    byteLength: retainedByteLength,
    retainedByteLength,
    truncated: false,
    redactionCount: 0,
  };
}

function historyWith(
  executions: ReadonlyArray<{
    readonly retainedLogBytes: number;
    readonly retainedMutationBytes: number | null;
  }>,
): RunHistoryDerivedState {
  return {
    state: 'verifying',
    checkpoint: null,
    attempts: [],
    cleanupProgress: null,
    sourceFrozen: null,
    guidanceFrozen: null,
    worktreeReady: null,
    roleSessions: [],
    roleControlRepairs: [],
    acceptedPlan: null,
    findings: [],
    implementation: null,
    permissionViolations: [],
    verifications: [
      {
        attempt: 1,
        repository: '/target',
        commit: 'b'.repeat(40),
        profileHash: SHA,
        commandMs: 1,
        result: 'passed',
        executions: executions.map((execution, index) => ({
          kind: 'gate',
          name: `gate-${index}`,
          executable: 'lint-tool',
          arguments: [],
          expectedExitCode: 0,
          actualExitCode: 0,
          timedOut: false,
          durationMs: 1,
          log: logReference(execution.retainedLogBytes),
          trackedMutation:
            execution.retainedMutationBytes === null
              ? null
              : {
                  sha256: SHA,
                  byteLength: execution.retainedMutationBytes,
                  retainedByteLength: execution.retainedMutationBytes,
                  truncated: false,
                  diff: logReference(execution.retainedMutationBytes),
                },
          reconstructed: false,
          reconstructionError: null,
        })),
      },
    ],
    testerSkips: [],
    validationLimitations: [],
    runtimeLifecycles: [],
  };
}

describe('evidence limits', () => {
  it('derives used optional-evidence bytes from retained logs and mutation diffs', () => {
    const history = historyWith([
      { retainedLogBytes: 100, retainedMutationBytes: null },
      { retainedLogBytes: 40, retainedMutationBytes: 60 },
    ]);

    expect(usedEvidenceBytes(history)).toBe(200);
    expect(evidenceLedger(history, 1000)).toEqual({ maxRunBytes: 1000, usedBytes: 200 });
  });

  it('admitOptionalEvidence admits within budget, refuses at and beyond the limit', () => {
    expect(
      admitOptionalEvidence({ history: { maxRunBytes: 100, usedBytes: 40 }, incomingBytes: 60 }),
    ).toEqual({ ok: true });
    expect(
      admitOptionalEvidence({ history: { maxRunBytes: 100, usedBytes: 40 }, incomingBytes: 61 }),
    ).toEqual({ ok: false, reason: 'run-evidence-limit-reached' });
    expect(
      admitOptionalEvidence({ history: { maxRunBytes: 100, usedBytes: 100 }, incomingBytes: 1 }),
    ).toEqual({
      ok: false,
      reason: 'run-evidence-limit-reached',
    });
    expect(
      admitOptionalEvidence({ history: { maxRunBytes: 0, usedBytes: 0 }, incomingBytes: 0 }),
    ).toEqual({
      ok: true,
    });
  });

  it('redacts every configured match and counts replacements', () => {
    const redacted = redactText('token=secret-token token=secret-token', ['secret-token']);
    expect(redacted.text).toBe('token=[REDACTED] token=[REDACTED]');
    expect(redacted.redactionCount).toBe(2);
  });

  it('redactText leaves invalid patterns untouched', () => {
    const redacted = redactText('keep secret', ['(unclosed', 'secret']);
    expect(redacted.text).toBe('keep [REDACTED]');
    expect(redacted.redactionCount).toBe(1);
  });

  it('flags redaction patterns that do not compile as ECMAScript regexes', () => {
    expect(invalidRedactionPatterns(['a+', '(?:ok)'])).toEqual([]);
    const invalid = invalidRedactionPatterns(['(unclosed']);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.pattern).toBe('(unclosed');
    expect(invalid[0]?.problem.length).toBeGreaterThan(0);
  });

  it('counts no bytes for a history whose evidence is mandatory only', () => {
    const history = historyWith([]);
    expect(usedEvidenceBytes(history)).toBe(0);
    expect(
      admitOptionalEvidence({ history: evidenceLedger(history, 10), incomingBytes: 10 }),
    ).toEqual({ ok: true });
  });

  it('never truncates mandatory event payloads through the canonical codec', () => {
    const envelope: RunEventEnvelope = {
      schemaVersion: 1,
      runId: 'RUN-TEST',
      revision: 1,
      eventId: '00000000-0000-4000-8000-000000000000',
      occurredAt: '2026-01-01T00:00:00.000Z',
      previousEventHash: null,
    };
    const reason = 'x'.repeat(200000);
    const event = sealRunEvent(envelope, {
      type: 'validation-limitation',
      payload: { reason, commit: 'c'.repeat(40) },
    });

    const encoded = new TextEncoder().encode(`${JSON.stringify(event)}\n`);
    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(RunEventSchema))(
      new TextDecoder().decode(encoded),
    );
    expect(decoded.type).toBe('validation-limitation');
    if (decoded.type !== 'validation-limitation') {
      throw new Error('unexpected event type');
    }
    expect(decoded.payload.reason).toBe(reason);
    expect(encoded.byteLength).toBeGreaterThan(reason.length);
  });
});
