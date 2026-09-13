import { createHash } from 'node:crypto';

import type {
  PlanAcceptedPayload,
  RunHistoryDerivedState,
  VerificationCompletedPayload,
} from '../../domain/run-history.js';
import type { ProjectConfiguration } from '../../domain/project-configuration.js';
import type { WorkflowRole } from '../../domain/workflow.js';

/**
 * Reports are passed through intact, never summarized into a new agent-authored
 * form. Ordering follows the role pipeline so a downstream role reads the
 * complete accepted narrative of every role before it.
 */
export const ROLE_PIPELINE_ORDER: ReadonlyArray<WorkflowRole> = [
  'architect',
  'coder',
  'tester',
  'reviewer',
];

export interface RolePacketReport {
  readonly role: WorkflowRole;
  readonly attempt: number;
  readonly narrative: string;
}

export interface RolePacketFacts {
  readonly sourceCommit: string;
  readonly resultCommit: string | null;
  readonly noChangeCandidate: boolean;
  readonly changedFiles: ReadonlyArray<string>;
  readonly checks: string;
  readonly tester: string;
  readonly retriesAndCorrections: string;
  readonly findings: string;
}

export interface AssembleRolePacketOptions {
  readonly role: WorkflowRole;
  readonly request: string;
  readonly guidance: string;
  readonly reports: ReadonlyArray<RolePacketReport>;
  readonly facts: RolePacketFacts;
  readonly maxBytes: number;
}

export interface RolePacketAttachment {
  readonly name: string;
  readonly content: string;
}

export type RolePacketAssembly =
  | {
      readonly ok: true;
      readonly prompt: string;
      readonly attachments: ReadonlyArray<RolePacketAttachment>;
    }
  | { readonly ok: false; readonly problem: string };

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function roleInstruction(role: WorkflowRole): string {
  switch (role) {
    case 'architect':
      return 'Produce the accepted plan narrative and its control envelope. Do not implement code.';
    case 'coder':
      return 'Implement the accepted plan on the run-owned worktree and commit the change.';
    case 'tester':
      return 'Observe the prepared application read-only. Do not create, change, or delete application data. Do not run project checks again.';
    case 'reviewer':
      return 'Evaluate the current commit, checks, observations, and history. Choose one closed outcome. Do not modify files.';
  }
}

export function renderRolePacketReports(reports: ReadonlyArray<RolePacketReport>): string {
  const blocks = reports.map(
    (report) =>
      `### ${report.role} report (attempt ${report.attempt})\n\n${report.narrative.trimEnd()}\n`,
  );
  return ['## Accepted role reports', '', ...blocks].join('\n');
}

export function renderRolePacketFacts(facts: RolePacketFacts): string {
  const changed = facts.changedFiles.length === 0 ? '(none)' : facts.changedFiles.join(', ');
  return [
    '## Foundry facts',
    '',
    `- Frozen source commit: ${facts.sourceCommit}`,
    `- Result commit: ${facts.resultCommit ?? '(none; validated no-change candidate)'}`,
    `- No-change candidate: ${facts.noChangeCandidate ? 'yes' : 'no'}`,
    `- Run-derived changed files: ${changed}`,
    `- Deterministic checks: ${facts.checks}`,
    `- Runtime/Tester: ${facts.tester}`,
    `- Retries and corrections: ${facts.retriesAndCorrections}`,
    `- Findings: ${facts.findings}`,
    '',
  ].join('\n');
}

function requestSection(request: string): string {
  return ['## Operator request', '', request.trimEnd(), ''].join('\n');
}

/**
 * Assembles one role prompt. The operator request and frozen guidance are
 * always inline; role reports and Foundry facts may move to bounded referenced
 * attachments when the configured handoff limit would be exceeded. Mandatory
 * text is never silently truncated: if the irreducible request and guidance do
 * not fit, assembly fails closed instead.
 */
export function assembleRolePacket(options: AssembleRolePacketOptions): RolePacketAssembly {
  const header = [`# Role turn: ${options.role}`, '', roleInstruction(options.role), ''].join('\n');
  const base = [header, requestSection(options.request), options.guidance].join('\n');

  if (utf8Bytes(base) > options.maxBytes) {
    return {
      ok: false,
      problem: `the operator request and frozen guidance require ${utf8Bytes(base)} bytes, which exceeds the configured handoff limit of ${options.maxBytes} bytes`,
    };
  }

  const sideReports = options.reports.map((report) => ({
    report,
    content: `### ${report.role} report (attempt ${report.attempt})\n\n${report.narrative.trimEnd()}\n`,
  }));
  let sideFacts: string | null = renderRolePacketFacts(options.facts);
  const attachments: Array<RolePacketAttachment> = [];

  const renderInline = (): string => {
    const parts = [base];
    if (sideFacts !== null) {
      parts.push(sideFacts);
    }
    if (sideReports.length > 0) {
      parts.push(
        ['## Accepted role reports', '', ...sideReports.map((entry) => entry.content)].join('\n'),
      );
    }
    if (attachments.length > 0) {
      const list = attachments
        .map(
          (attachment) =>
            `- ${attachment.name} (${utf8Bytes(attachment.content)} bytes, sha256 ${sha256Hex(attachment.content)})`,
        )
        .join('\n');
      parts.push(`## Referenced attachments\n\n${list}\n`);
    }
    return parts.join('\n');
  };

  while (utf8Bytes(renderInline()) > options.maxBytes) {
    if (sideReports.length > 0) {
      let largestIndex = 0;
      for (let index = 1; index < sideReports.length; index += 1) {
        if (sideReports[index]!.content.length > sideReports[largestIndex]!.content.length) {
          largestIndex = index;
        }
      }
      const [moved] = sideReports.splice(largestIndex, 1);
      if (moved === undefined) {
        break;
      }
      attachments.push({
        name: `report-${moved.report.role}-${moved.report.attempt}.md`,
        content: moved.content,
      });
      continue;
    }
    if (sideFacts !== null) {
      attachments.push({ name: 'foundry-facts.md', content: sideFacts });
      sideFacts = null;
      continue;
    }
    return {
      ok: false,
      problem: 'mandatory role evidence cannot be retained within the configured handoff limit',
    };
  }

  return { ok: true, prompt: renderInline(), attachments };
}

function verificationSummary(reports: ReadonlyArray<VerificationCompletedPayload>): string {
  if (reports.length === 0) {
    return 'no commit-bound verification report is recorded';
  }
  const latest = reports[reports.length - 1]!;
  const commands = latest.executions
    .map((execution) => `${execution.name}=${execution.actualExitCode}`)
    .join(' ');
  return `${latest.result} at ${latest.commit} (attempt ${latest.attempt}; ${commands})`;
}

export interface BuildRolePacketOptions {
  readonly role: WorkflowRole;
  readonly request: string;
  readonly guidance: string;
  readonly history: RunHistoryDerivedState;
  readonly configuration: ProjectConfiguration;
}

function priorReports(
  role: WorkflowRole,
  history: RunHistoryDerivedState,
): ReadonlyArray<RolePacketReport> {
  const reports: Array<RolePacketReport> = [];
  for (const pipelineRole of ROLE_PIPELINE_ORDER) {
    if (pipelineRole === role) {
      continue;
    }
    for (const session of history.roleSessions) {
      if (session.role !== pipelineRole) {
        continue;
      }
      const observation = session.lastObservation;
      if (
        observation !== null &&
        observation.status === 'settled' &&
        observation.narrative !== null
      ) {
        reports.push({
          role: session.role,
          attempt: session.attempt,
          narrative: observation.narrative,
        });
      }
    }
  }
  return reports;
}

function testerFact(
  role: WorkflowRole,
  plan: PlanAcceptedPayload | null,
  history: RunHistoryDerivedState,
): string {
  if (plan !== null && !plan.runtimeValidationRequired) {
    return 'not required by the accepted plan; explicitly skipped without a passing observation';
  }
  const skip = history.testerSkips[history.testerSkips.length - 1];
  if (skip !== undefined) {
    return `skipped: ${skip.reason}`;
  }
  const limitation = history.validationLimitations[history.validationLimitations.length - 1];
  if (limitation !== undefined) {
    return `limitation recorded: ${limitation.reason}`;
  }
  if (role === 'reviewer' || role === 'tester') {
    return 'required; see the Tester report and runtime lifecycle evidence';
  }
  return 'required by the accepted plan';
}

function findingsFact(history: RunHistoryDerivedState): string {
  const corrections = history.attempts.filter((attempt) => attempt.kind === 'repair');
  if (corrections.length === 0) {
    return 'no recorded control repairs; see Reviewer reports for any findings';
  }
  return `${corrections.length} recorded control repair(s)`;
}

export function buildRolePacket(options: BuildRolePacketOptions): RolePacketAssembly {
  const history = options.history;
  const plan = history.acceptedPlan;
  const implementation = history.implementation;
  const resultCommit =
    implementation === null ? null : (implementation.commit ?? implementation.baseCommit);
  const retryAttempts = history.attempts.filter((attempt) => attempt.kind === 'retry');
  const facts: RolePacketFacts = {
    sourceCommit: history.sourceFrozen?.sourceCommit ?? '(not frozen)',
    resultCommit,
    noChangeCandidate: implementation?.noChangeCandidate ?? false,
    changedFiles: implementation?.changedFiles ?? [],
    checks: verificationSummary(history.verifications),
    tester: testerFact(options.role, plan, history),
    retriesAndCorrections:
      retryAttempts.length === 0
        ? 'no role retries recorded'
        : retryAttempts
            .map((attempt) => `${attempt.role} ${attempt.state}: ${attempt.reason}`)
            .join('; '),
    findings: findingsFact(history),
  };
  return assembleRolePacket({
    role: options.role,
    request: options.request,
    guidance: options.guidance,
    reports: priorReports(options.role, history),
    facts,
    maxBytes: options.configuration.artifacts.maxRoleHandoffBytes,
  });
}
