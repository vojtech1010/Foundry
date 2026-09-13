import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { ProjectCommandProcess } from '../src/application/profile-check/index.js';
import { ReadinessHost } from '../src/application/readiness/index.js';
import { GuidanceLive } from '../src/platform/guidance.js';
import { RunGitLive } from '../src/platform/git-provisioning.js';
import { ProjectCommandsPlatformLive } from '../src/platform/project-commands.js';
import { ReadinessFilesLive, ReadinessGitLive } from '../src/platform/readiness.js';
import { RepositoryLeaseLive } from '../src/platform/repository-lease.js';
import { RoleTurnResourceObserverLive } from '../src/platform/role-permissions.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import { goldenConfigurationDocument } from './fixtures/checks-runtime-run.js';
import { scriptedRoleHostLauncher } from './fixtures/role-host/role-host-launcher.js';

import type { RoleHostLauncher } from '../src/application/role-conversations/index.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

interface Fixture {
  readonly base: string;
  readonly target: string;
  readonly remote: string;
  readonly configPath: string;
  readonly requestPath: string;
  readonly cleanup: () => void;
}

function gitExec(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

function setupFixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), 'foundry-run-lifecycle-'));
  const target = join(base, 'target');
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', target], { encoding: 'utf8' });
  gitExec(target, ['config', 'user.email', 'lifecycle@example.com']);
  gitExec(target, ['config', 'user.name', 'Foundry Lifecycle']);
  writeFileSync(join(target, '.gitignore'), '.agent\n');
  writeFileSync(join(target, 'README.md'), '# target\n');
  gitExec(target, ['add', '.gitignore', 'README.md']);
  gitExec(target, ['commit', '-m', 'initial']);
  gitExec(target, ['remote', 'add', 'origin', remote]);
  gitExec(target, ['push', '-u', 'origin', 'main']);
  const configPath = join(base, 'foundry.config.json');
  writeFileSync(configPath, JSON.stringify(goldenConfigurationDocument(target, true)));
  const requestPath = join(base, 'request.md');
  writeFileSync(requestPath, '# Outcome\n\nMake the app observable.\n');
  return {
    base,
    target,
    remote,
    configPath,
    requestPath,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const capabilityLayers = Layer.mergeAll(
  Layer.succeed(
    ReadinessHost,
    ReadinessHost.of({
      platform: Effect.succeed('linux'),
      nodeVersion: Effect.succeed('v24.0.0'),
      npmVersion: Effect.succeed('11.0.0'),
      gitVersionOutput: Effect.succeed('git version 2.45.0'),
    }),
  ),
  ReadinessFilesLive,
  ReadinessGitLive,
  Layer.succeed(
    ProjectCommandProcess,
    ProjectCommandProcess.of({
      run: (_options: { readonly command: ReadonlyArray<string>; readonly cwd: string }) =>
        Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
    }),
  ),
  ProjectCommandsPlatformLive,
  RunIdentityLive,
  RunHistoryLive,
  RepositoryLeaseLive,
  RoleTurnResourceObserverLive,
  RunGitLive,
  GuidanceLive,
);

function withRoleHost(roleHost: Layer.Layer<RoleHostLauncher>) {
  return Layer.mergeAll(capabilityLayers, roleHost);
}

function runWithFixture(fixture: Fixture, runId: string) {
  const roleHost = scriptedRoleHostLauncher({
    architect: {
      narrative: 'The plan is ready.',
      control: {
        schemaVersion: 1,
        outcome: 'plan_ready',
        acceptanceCriteria: ['the app is observable'],
        runtimeValidation: 'required',
        execution: 'sequential',
      },
    },
    coder: {
      narrative: 'No implementation change is required.',
      control: { schemaVersion: 1, outcome: 'no_change_candidate' },
    },
    tester: [
      {
        narrative: 'The first observation needs another try.',
        control: { schemaVersion: 1, outcome: 'retry_required' },
      },
      {
        narrative: 'The application was observed read-only.',
        control: { schemaVersion: 1, outcome: 'observed' },
      },
    ],
    reviewer: {
      narrative: 'The verified source already satisfies the request.',
      control: { schemaVersion: 1, outcome: 'approved' },
    },
  });
  return runCli([
    'run',
    '--config',
    fixture.configPath,
    '--request',
    fixture.requestPath,
    '--task-id',
    'TASK-LIFECYCLE',
    '--run-id',
    runId,
    '--json',
  ]).pipe(Effect.provide(withRoleHost(roleHost)));
}

function runArchitectNoChange(fixture: Fixture, runId: string) {
  const roleHost = scriptedRoleHostLauncher({
    architect: {
      narrative: 'The frozen source already satisfies the request.',
      control: {
        schemaVersion: 1,
        outcome: 'no_change_candidate',
        acceptanceCriteria: ['the app is already observable'],
        runtimeValidation: 'not_required',
      },
    },
    reviewer: {
      narrative: 'The verified source already satisfies the request.',
      control: { schemaVersion: 1, outcome: 'approved' },
    },
  });
  return runCli([
    'run',
    '--config',
    fixture.configPath,
    '--request',
    fixture.requestPath,
    '--task-id',
    'TASK-LIFECYCLE',
    '--run-id',
    runId,
    '--json',
  ]).pipe(Effect.provide(withRoleHost(roleHost)));
}

function runBlockedReviewer(fixture: Fixture, runId: string) {
  const roleHost = scriptedRoleHostLauncher({
    architect: {
      narrative: 'The plan is ready.',
      control: {
        schemaVersion: 1,
        outcome: 'plan_ready',
        acceptanceCriteria: ['the change works'],
        runtimeValidation: 'not_required',
        execution: 'sequential',
      },
    },
    coder: {
      narrative: 'No change is required.',
      control: { schemaVersion: 1, outcome: 'no_change_candidate' },
    },
    reviewer: {
      narrative: 'Reviewer cannot safely review.',
      control: { schemaVersion: 1, outcome: 'blocked' },
    },
  });
  return runCli([
    'run',
    '--config',
    fixture.configPath,
    '--request',
    fixture.requestPath,
    '--task-id',
    'TASK-LIFECYCLE',
    '--run-id',
    runId,
    '--json',
  ]).pipe(Effect.provide(withRoleHost(roleHost)));
}

function runRetestFlow(fixture: Fixture, runId: string) {
  const roleHost = scriptedRoleHostLauncher({
    architect: {
      narrative: 'The plan requires runtime validation.',
      control: {
        schemaVersion: 1,
        outcome: 'plan_ready',
        acceptanceCriteria: ['the app is observable'],
        runtimeValidation: 'required',
        execution: 'sequential',
      },
    },
    coder: {
      narrative: 'No implementation change is required.',
      control: { schemaVersion: 1, outcome: 'no_change_candidate' },
    },
    tester: {
      narrative: 'Observed the prepared application read-only.',
      control: { schemaVersion: 1, outcome: 'observed' },
    },
    reviewer: [
      {
        narrative: 'One more independent observation is needed.',
        control: { schemaVersion: 1, outcome: 'retest_requested' },
      },
      {
        narrative: 'The retest confirms the result.',
        control: { schemaVersion: 1, outcome: 'approved' },
      },
    ],
  });
  return runCli([
    'run',
    '--config',
    fixture.configPath,
    '--request',
    fixture.requestPath,
    '--task-id',
    'TASK-LIFECYCLE',
    '--run-id',
    runId,
    '--json',
  ]).pipe(Effect.provide(withRoleHost(roleHost)));
}

function readHistory(fixture: Fixture, runId: string) {
  return readVerifiedRunHistory({
    runDirectory: join(fixture.target, '.agent', 'runs', runId),
    runId,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

describe('run owns the first pass through review', () => {
  it.live('reaches a first Reviewer outcome with a held runtime and same-commit Tester retry', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const result = yield* runWithFixture(fixture, 'RUN-LIFECYCLE');
        expect(result.exitCode).toBe(0);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(true);
        if (!envelope.ok || !('request' in envelope.data) || !('workflowState' in envelope.data)) {
          throw new Error(`Expected a run workflow envelope: ${result.stdout}`);
        }
        expect(envelope.data.workflowState).toBe('completed_no_change');
        expect(envelope.data.outcome).toBe('completed_no_change');
        expect(envelope.data.stages).toContain('testing');
        expect(envelope.data.stages).toContain('reviewing');

        const history = yield* readHistory(fixture, 'RUN-LIFECYCLE');
        expect(history.derived.state).toBe('completed_no_change');
        expect(
          history.derived.attempts.some(
            (attempt) => attempt.kind === 'retry' && attempt.role === 'tester',
          ),
        ).toBe(true);
        const testerSessions = history.derived.roleSessions.filter(
          (session) => session.role === 'tester',
        );
        expect(testerSessions).toHaveLength(2);
        expect(history.derived.implementation?.commit ?? null).toBeNull();
        const lifecycles = history.derived.runtimeLifecycles;
        expect(lifecycles.length).toBeGreaterThanOrEqual(2);
        expect(lifecycles[0]?.outcome).toBe('ready');
        const final = lifecycles[lifecycles.length - 1];
        expect(final?.cleanup).toBe('disposed');
        expect(final?.stoppedAt).not.toBeNull();
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('completes an Architect-nominated no-change candidate on the frozen source', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const result = yield* runArchitectNoChange(fixture, 'RUN-ARCH-NOCHANGE');
        expect(result.exitCode).toBe(0);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(true);
        if (!envelope.ok || !('workflowState' in envelope.data)) {
          throw new Error(`Expected a run workflow envelope: ${result.stdout}`);
        }
        expect(envelope.data.workflowState).toBe('completed_no_change');

        const history = yield* readHistory(fixture, 'RUN-ARCH-NOCHANGE');
        expect(history.derived.state).toBe('completed_no_change');
        expect(history.derived.implementation).toMatchObject({
          commit: null,
          noChangeCandidate: true,
          changedFiles: [],
        });
        expect(history.derived.roleSessions.some((session) => session.role === 'coder')).toBe(
          false,
        );
        const sourceCommit = history.derived.sourceFrozen?.sourceCommit ?? null;
        const noChangeVerification = history.derived.verifications.find(
          (report) => report.result === 'passed',
        );
        expect(noChangeVerification?.commit).toBe(sourceCommit);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('resume continues the same run without repeating an accepted transition', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const first = yield* runWithFixture(fixture, 'RUN-RESUME');
        expect(first.exitCode).toBe(0);
        const before = yield* readHistory(fixture, 'RUN-RESUME');
        const sessionsBefore = before.derived.roleSessions.length;

        const resumed = yield* runCli([
          'resume',
          '--config',
          fixture.configPath,
          '--run-id',
          'RUN-RESUME',
          '--json',
        ]).pipe(Effect.provide(withRoleHost(scriptedRoleHostLauncher({}))));
        expect(resumed.exitCode).toBe(0);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(resumed.stdout);
        expect(envelope.ok).toBe(true);
        if (!envelope.ok || !('workflowState' in envelope.data)) {
          throw new Error(`Expected a resume envelope: ${resumed.stdout}`);
        }
        expect(envelope.data.workflowState).toBe('completed_no_change');

        const after = yield* readHistory(fixture, 'RUN-RESUME');
        expect(after.derived.state).toBe('completed_no_change');
        expect(after.derived.roleSessions.length).toBe(sessionsBefore);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('reports a blocked first pass with a blocked failure envelope', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const result = yield* runBlockedReviewer(fixture, 'RUN-BLOCKED');
        expect(result.exitCode).toBe(1);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(false);
        if (envelope.ok) {
          throw new Error(`Expected a blocked failure envelope: ${result.stdout}`);
        }
        expect(envelope.error.kind).toBe('blocked');
        expect(envelope.error.runId).toBe('RUN-BLOCKED');
        const history = yield* readHistory(fixture, 'RUN-BLOCKED');
        expect(history.derived.state).toBe('blocked');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('re-prepares the runtime for a Reviewer-requested retest on the same commit', () =>
    Effect.gen(function* () {
      const fixture = setupFixture();
      try {
        const result = yield* runRetestFlow(fixture, 'RUN-RETEST');
        expect(result.exitCode).toBe(0);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(true);
        if (!envelope.ok || !('workflowState' in envelope.data)) {
          throw new Error(`Expected a run workflow envelope: ${result.stdout}`);
        }
        expect(envelope.data.workflowState).toBe('completed_no_change');

        const history = yield* readHistory(fixture, 'RUN-RETEST');
        expect(history.derived.state).toBe('completed_no_change');
        const testerSessions = history.derived.roleSessions.filter(
          (session) => session.role === 'tester',
        );
        expect(testerSessions).toHaveLength(2);
        const readyRecords = history.derived.runtimeLifecycles.filter(
          (record) => record.outcome === 'ready',
        );
        expect(readyRecords.length).toBeGreaterThanOrEqual(2);
        expect(history.derived.implementation?.commit ?? null).toBeNull();
      } finally {
        fixture.cleanup();
      }
    }),
  );
});
