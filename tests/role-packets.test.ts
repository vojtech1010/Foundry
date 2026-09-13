import { describe, expect, it } from '@effect/vitest';

import {
  assembleRolePacket,
  buildRolePacket,
  renderRolePacketFacts,
} from '../src/application/role-packets/index.js';

import type { RolePacketFacts } from '../src/application/role-packets/index.js';
import type { ProjectConfiguration } from '../src/domain/project-configuration.js';
import type { FindingRecord } from '../src/domain/findings.js';
import type { RunHistoryDerivedState, PlanAcceptedPayload } from '../src/domain/run-history.js';
import type { RoleHostSessionState } from '../src/domain/role-host.js';

const FACTS: RolePacketFacts = {
  sourceCommit: 'a'.repeat(40),
  resultCommit: 'b'.repeat(40),
  noChangeCandidate: false,
  changedFiles: ['src/a.ts'],
  checks: 'passed at commit',
  tester: 'required',
  retriesAndCorrections: 'none',
  findings: 'none',
  captures: 'no settled Tester capture manifest is recorded',
};

function session(
  role: 'architect' | 'coder' | 'tester' | 'reviewer',
  narrative: string,
): RoleHostSessionState {
  return {
    role,
    attempt: 1,
    generation: 1,
    sessionId: `session-${role}`,
    ownershipToken: `owner-${role}`,
    initialSequence: 0,
    runtimeIdentity: {
      adapterVersion: 'test',
      provider: 'test',
      model: 'test',
      toolProfile: 'test',
    },
    workingDirectory: null,
    submission: null,
    submissionStarted: null,
    lastObservation: {
      status: 'settled',
      sequence: 1,
      eventCount: 1,
      narrative,
      control: { schemaVersion: 1, outcome: 'observed' },
    },
    stopDisposition: null,
  };
}

function derived(
  roleSessions: ReadonlyArray<RoleHostSessionState>,
  findings: ReadonlyArray<FindingRecord> = [],
): RunHistoryDerivedState {
  const acceptedPlan: PlanAcceptedPayload = {
    outcome: 'plan_ready',
    criteria: [{ id: 'AC-001', text: 'works' }],
    runtimeValidationRequired: false,
    execution: {
      mode: 'sequential',
      objectives: [
        { id: 'OBJ-001', title: 'do it', affectedPaths: ['.'], criterionIds: ['AC-001'] },
      ],
    },
  };
  return {
    state: 'reviewing',
    checkpoint: null,
    attempts: [],
    cleanupProgress: null,
    sourceFrozen: null,
    guidanceFrozen: null,
    worktreeReady: null,
    roleSessions,
    acceptedPlan,
    findings,
    implementation: {
      taskBranch: 'foundry/TASK',
      baseCommit: 'a'.repeat(40),
      commit: 'b'.repeat(40),
      changedFiles: ['src/a.ts'],
      noChangeCandidate: false,
    },
    permissionViolations: [],
    verifications: [],
    testerSkips: [],
    validationLimitations: [],
    runtimeLifecycles: [],
  };
}

function configuration(maxRoleHandoffBytes: number): ProjectConfiguration {
  // SAFETY: packet assembly reads only artifacts.maxRoleHandoffBytes from configuration.
  return { artifacts: { maxRoleHandoffBytes } } as ProjectConfiguration;
}

describe('role packets', () => {
  it('passes the operator request, frozen guidance, facts, and prior reports through intact', () => {
    const request = '# Outcome\n\nShip the change.\n';
    const guidance = '## Frozen project guidance\n\nDo not reread files.\n';
    const architectReport = '# Plan\n\nThe architect narrative.';
    const coderReport = '# Implementation\n\nThe coder narrative.';
    const packet = assembleRolePacket({
      role: 'reviewer',
      request,
      guidance,
      reports: [
        { role: 'architect', attempt: 1, narrative: architectReport },
        { role: 'coder', attempt: 1, narrative: coderReport },
      ],
      facts: FACTS,
      maxBytes: 100_000,
    });
    expect(packet.ok).toBe(true);
    if (!packet.ok) {
      return;
    }
    expect(packet.attachments).toHaveLength(0);
    expect(packet.prompt).toContain(request);
    expect(packet.prompt).toContain(guidance);
    expect(packet.prompt).toContain(architectReport);
    expect(packet.prompt).toContain(coderReport);
    expect(packet.prompt).toContain('## Foundry facts');
    expect(packet.prompt).toContain(`Frozen source commit: ${FACTS.sourceCommit}`);
    expect(packet.prompt.indexOf(architectReport)).toBeLessThan(packet.prompt.indexOf(coderReport));
  });

  it('moves large reports into bounded referenced attachments instead of cutting them', () => {
    const request = '# Outcome\n\nShip it.\n';
    const guidance = '## Frozen project guidance\n\nGuidance.\n';
    const large = `# Reviewer findings\n\n${'x'.repeat(5_000)}`;
    const packet = assembleRolePacket({
      role: 'coder',
      request,
      guidance,
      reports: [{ role: 'reviewer', attempt: 1, narrative: large }],
      facts: FACTS,
      maxBytes: 2_000,
    });
    expect(packet.ok).toBe(true);
    if (!packet.ok) {
      return;
    }
    expect(packet.prompt).not.toContain('x'.repeat(5_000));
    expect(packet.attachments).toHaveLength(1);
    expect(packet.attachments[0]?.content).toContain('x'.repeat(5_000));
    expect(packet.prompt).toContain('## Referenced attachments');
    expect(packet.prompt).toContain('report-reviewer-1.md');
    expect(packet.prompt).toContain(request);
    expect(packet.prompt).toContain(guidance);
  });

  it('fails closed when the request and guidance alone exceed the limit', () => {
    const packet = assembleRolePacket({
      role: 'architect',
      request: 'r'.repeat(2_000),
      guidance: 'g'.repeat(2_000),
      reports: [],
      facts: FACTS,
      maxBytes: 1_000,
    });
    expect(packet.ok).toBe(false);
  });

  it('derives prior accepted reports from recorded role sessions', () => {
    const packet = buildRolePacket({
      role: 'reviewer',
      request: 'the request',
      guidance: 'the guidance',
      history: derived([
        session('architect', 'architect narrative'),
        session('coder', 'coder narrative'),
        session('tester', 'tester narrative'),
        session('reviewer', 'reviewer narrative'),
      ]),
      configuration: configuration(100_000),
    });
    expect(packet.ok).toBe(true);
    if (!packet.ok) {
      return;
    }
    expect(packet.prompt).toContain('architect narrative');
    expect(packet.prompt).toContain('coder narrative');
    expect(packet.prompt).toContain('tester narrative');
    expect(packet.prompt).not.toContain('reviewer narrative');
  });

  it('renders Foundry facts deterministically', () => {
    expect(renderRolePacketFacts(FACTS)).toContain('Result commit: ' + FACTS.resultCommit);
    expect(renderRolePacketFacts(FACTS)).toContain('changed files: src/a.ts');
  });

  const currentFinding: FindingRecord = {
    id: 'FND-001',
    category: 'review',
    source: 'reviewer-changes-requested',
    owner: 'coder',
    severity: 'high',
    blocking: true,
    commit: 'b'.repeat(40),
    description: 'Reviewer requested changes to the empty state.',
    detail: 'the full narrative',
    evidence: ['review.md'],
  };

  const olderFinding: FindingRecord = {
    ...currentFinding,
    id: 'FND-001',
    commit: 'c'.repeat(40),
    description: 'An older finding for a retired head.',
  };

  it('surfaces current-head findings to Coder and Reviewer and retains older findings', () => {
    for (const role of ['coder', 'reviewer'] as const) {
      const packet = buildRolePacket({
        role,
        request: 'the request',
        guidance: 'the guidance',
        history: derived([], [olderFinding, currentFinding]),
        configuration: configuration(100_000),
      });
      expect(packet.ok).toBe(true);
      if (!packet.ok) {
        return;
      }
      expect(packet.prompt).toContain(
        'FND-001 [high, blocking] Reviewer requested changes to the empty state.',
      );
      expect(packet.prompt).toContain('1 earlier finding(s) retained as history');
      expect(packet.prompt).not.toContain('An older finding for a retired head.');
    }
  });

  it('does not surface findings to roles that do not consume them', () => {
    const packet = buildRolePacket({
      role: 'architect',
      request: 'the request',
      guidance: 'the guidance',
      history: derived([], [currentFinding]),
      configuration: configuration(100_000),
    });
    expect(packet.ok).toBe(true);
    if (!packet.ok) {
      return;
    }
    expect(packet.prompt).toContain('findings are surfaced to Coder and Reviewer only');
    expect(packet.prompt).not.toContain('Reviewer requested changes to the empty state.');
  });
});
