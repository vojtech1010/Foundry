import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  blockingFindings,
  checkFindings,
  currentHeadFindings,
  environmentFailures,
  findingAlreadyRecorded,
  findingCompanionFilename,
  findingCompanionPath,
  isEnvironmentFailure,
  isFailedProjectCommand,
  olderFindings,
  recordFinding,
  renderFindingCompanion,
  renderReviewResultDocument,
  reviewResultEntries,
  reviewerCorrectionFinding,
  validateReviewResultEntries,
  FindingCompanionJson,
  ReviewResultJson,
} from '../src/application/findings/index.js';
import { readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { FINDING_COMPANION_SCHEMA_VERSION, FindingRecordSchema } from '../src/domain/findings.js';
import { IMPLEMENTED_COMMIT, RUN_ID, seedVerifyingRun } from './fixtures/checks-runtime-run.js';

import type { VerificationExecution } from '../src/domain/project-verification.js';

const COMMIT = 'a'.repeat(40);

function execution(overrides: Partial<VerificationExecution> = {}): VerificationExecution {
  return {
    kind: 'gate',
    name: 'lint',
    executable: 'lint-tool',
    arguments: ['--strict'],
    expectedExitCode: 0,
    actualExitCode: 1,
    timedOut: false,
    durationMs: 12,
    log: {
      path: '/evidence/lint.log',
      sha256: 'b'.repeat(64),
      byteLength: 10,
      retainedByteLength: 10,
      truncated: false,
      redactionCount: 0,
    },
    trackedMutation: null,
    reconstructed: false,
    reconstructionError: null,
    ...overrides,
  };
}

function report(executions: ReadonlyArray<VerificationExecution>, result: 'passed' | 'failed') {
  return {
    attempt: 1,
    repository: '/target',
    commit: COMMIT,
    profileHash: 'c'.repeat(64),
    commandMs: 900000,
    executions,
    result,
  };
}

describe('foundry-owned finding records', () => {
  it('records one finding per failed deterministic command bound to the checked commit', () => {
    const findings = checkFindings({
      report: report(
        [
          execution(),
          execution({ name: 'typecheck', actualExitCode: 2 }),
          execution({ name: 'test', actualExitCode: 0 }),
        ],
        'failed',
      ),
      nextIndex: 1,
    });
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.id)).toEqual(['FND-001', 'FND-002']);
    expect(findings.map((finding) => finding.category)).toEqual(['check', 'check']);
    expect(findings.every((finding) => finding.commit === COMMIT)).toBe(true);
    expect(findings.every((finding) => finding.blocking && finding.owner === 'coder')).toBe(true);
    expect(findings[0]?.description).toContain('lint');
    expect(findings[0]?.evidence.join('\n')).toContain('/evidence/lint.log');
    for (const finding of findings) {
      expect(
        Schema.decodeUnknownSync(FindingRecordSchema, { onExcessProperty: 'error' })(finding),
      ).toEqual(finding);
    }
  });

  it('keeps environment and operational failures separate from Coder findings', () => {
    const bootstrap = execution({ kind: 'bootstrap', name: 'bootstrap' });
    const mutation = execution({
      name: 'test',
      trackedMutation: {
        sha256: 'd'.repeat(64),
        byteLength: 4,
        retainedByteLength: 4,
        truncated: false,
        diff: execution().log,
      },
    });
    const reconstructed = execution({ name: 'build', reconstructed: true });
    const failedReport = report([bootstrap, mutation, reconstructed], 'failed');

    expect(isFailedProjectCommand(bootstrap)).toBe(false);
    expect(isFailedProjectCommand(mutation)).toBe(false);
    expect(isFailedProjectCommand(reconstructed)).toBe(false);
    expect(isEnvironmentFailure(bootstrap)).toBe(true);
    expect(environmentFailures(failedReport)).toHaveLength(3);
    expect(checkFindings({ report: failedReport, nextIndex: 1 })).toHaveLength(0);
    expect(isFailedProjectCommand(execution({ actualExitCode: 0 }))).toBe(false);
    expect(isEnvironmentFailure(execution({ actualExitCode: 0 }))).toBe(false);
  });

  it('builds one blocking correction brief that keeps the full unmodified Markdown', () => {
    const narrative = '# Reviewer findings\n\n1. The empty state is missing.\n';
    const finding = reviewerCorrectionFinding({
      id: 'FND-001',
      commit: COMMIT,
      narrative,
      evidence: ['review.md sha256:deadbeef', `commit ${COMMIT}`],
    });
    expect(finding.category).toBe('review');
    expect(finding.source).toBe('reviewer-changes-requested');
    expect(finding.blocking).toBe(true);
    expect(finding.severity).toBe('high');
    expect(finding.detail).toBe(narrative);
    expect(blockingFindings([finding])).toEqual([finding]);
  });

  it('renders closed companions and rejects unknown or mismatched entries', () => {
    const finding = reviewerCorrectionFinding({
      id: 'FND-001',
      commit: COMMIT,
      narrative: 'the narrative',
      evidence: ['review.md'],
    });

    const companion = renderFindingCompanion(finding);
    const decoded = Schema.decodeUnknownSync(FindingCompanionJson, { onExcessProperty: 'error' })(
      companion,
    );
    expect(decoded.schemaVersion).toBe(FINDING_COMPANION_SCHEMA_VERSION);
    expect(decoded.finding).toEqual(finding);
    expect(findingCompanionFilename(finding)).toBe('FND-001.json');
    expect(findingCompanionPath('/run/attempts/reviewer/001', finding)).toContain('FND-001.json');

    const resultDocument = Schema.decodeUnknownSync(ReviewResultJson, {
      onExcessProperty: 'error',
    })(renderReviewResultDocument([finding]));
    expect(resultDocument.result).toEqual([
      { id: 'FND-001', severity: 'high', title: finding.description },
    ]);
    expect(Object.keys(resultDocument.result[0]!).sort()).toEqual(['id', 'severity', 'title']);

    expect(validateReviewResultEntries(reviewResultEntries([finding]), [finding])).toEqual({
      ok: true,
    });
    const severityMismatch = validateReviewResultEntries(
      [{ id: 'FND-001', severity: 'low', title: finding.description }],
      [finding],
    );
    expect(severityMismatch.ok).toBe(false);
    if (!severityMismatch.ok) {
      expect(severityMismatch.problem).toContain('severity');
    }
    const titleMismatch = validateReviewResultEntries(
      [{ id: 'FND-001', severity: 'high', title: 'other' }],
      [finding],
    );
    expect(titleMismatch.ok).toBe(false);
    if (!titleMismatch.ok) {
      expect(titleMismatch.problem).toContain('title');
    }
    const omitted = validateReviewResultEntries([], [finding]);
    expect(omitted.ok).toBe(false);
    if (!omitted.ok) {
      expect(omitted.problem).toContain('omits');
    }
  });

  it('treats findings as immutable current-head evidence with retained history', () => {
    const current = reviewerCorrectionFinding({
      id: 'FND-002',
      commit: COMMIT,
      narrative: 'current',
      evidence: ['review.md'],
    });
    const older = reviewerCorrectionFinding({
      id: 'FND-001',
      commit: 'e'.repeat(40),
      narrative: 'older',
      evidence: ['review.md'],
    });
    expect(currentHeadFindings([older, current], COMMIT)).toEqual([current]);
    expect(olderFindings([older, current], COMMIT)).toEqual([older]);
    expect(currentHeadFindings([older, current], null)).toEqual([]);
    expect(findingAlreadyRecorded([older], current)).toBe(false);
    expect(findingAlreadyRecorded([older, current], current)).toBe(true);
  });

  it('rejects a finding whose description exceeds the closed REVIEW_RESULT limit', () => {
    expect(() =>
      Schema.decodeUnknownSync(FindingRecordSchema, { onExcessProperty: 'error' })({
        id: 'FND-001',
        category: 'check',
        source: 'failed-check',
        owner: 'coder',
        severity: 'high',
        blocking: true,
        commit: COMMIT,
        description: 'x'.repeat(513),
        detail: 'detail',
        evidence: ['evidence'],
      }),
    ).toThrow();
  });

  it.effect('persists a Reviewer correction brief as a durable finding', () =>
    Effect.gen(function* () {
      const base = mkdtempSync(join(tmpdir(), 'foundry-findings-'));
      const runDirectory = join(base, '.agent', 'runs', RUN_ID);
      mkdirSync(runDirectory, { recursive: true });
      try {
        yield* seedVerifyingRun({ runDirectory, runtimeValidationRequired: false }).pipe(
          Effect.provide(RunHistoryLive),
        );
        const finding = reviewerCorrectionFinding({
          id: 'FND-001',
          commit: IMPLEMENTED_COMMIT,
          narrative: '# Reviewer findings\n\nClose every medium finding.\n',
          evidence: ['review.md'],
        });
        yield* recordFinding({ runDirectory, runId: RUN_ID, finding }).pipe(
          Effect.provide(RunHistoryLive),
        );
        const history = yield* readVerifiedRunHistory({
          runDirectory,
          runId: RUN_ID,
          createIfMissing: false,
        }).pipe(Effect.provide(RunHistoryLive));
        expect(history.derived.findings).toEqual([finding]);
        expect(history.derived.findings[0]?.detail).toContain('Reviewer findings');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }),
  );
});
