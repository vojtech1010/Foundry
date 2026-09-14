import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HANDOFF_FILENAME, HandoffDocumentSchema } from '../src/application/handoff/index.js';
import { GitHubPublication } from '../src/application/decision-publication/index.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { ProjectCommandProcess } from '../src/application/profile-check/index.js';
import {
  PublicationProbe,
  ReadinessGit,
  ReadinessHost,
} from '../src/application/readiness/index.js';
import { RoleHost } from '../src/application/role-conversations/index.js';
import { readVerifiedRunHistory } from '../src/application/run-history/index.js';
import {
  STAND_IN_ROLE_HOST_CAPABILITIES,
  standInRoleHost,
  type StandInRoleHostScript,
  type StandInSettledTurn,
  type StandInTurnAct,
  type StandInTurnContext,
} from '../src/application/stand-in-role-host/index.js';
import { ReportEnvelope, runCli } from '../src/cli/program.js';
import {
  ROLE_HOST_PROTOCOL_VERSION,
  RoleHostCapabilitiesResponseSchema,
  RoleHostObserveResponseSchema,
  evaluateRoleHostCapabilities,
} from '../src/domain/role-host.js';
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

import type { Layer as EffectLayer } from 'effect';
import type { RoleHostLauncher } from '../src/application/role-conversations/index.js';
import type {
  GitHubPullRequest,
  GitHubPushTaskBranchOptions,
} from '../src/application/decision-publication/index.js';
import type { RoleHostCreateRequest } from '../src/domain/role-host.js';
import type { VerifiedRunHistory } from '../src/application/run-history/index.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

const HandoffDocumentJson = Schema.fromJsonString(HandoffDocumentSchema);

const STRICT = { onExcessProperty: 'error' } as const;

const PUBLICATION_REMOTE_URL = 'https://github.com/example/target.git';

interface Fixture {
  readonly base: string;
  readonly target: string;
  readonly configPath: string;
  readonly requestPath: string;
  readonly config: (publish: boolean) => string;
  readonly cleanup: () => void;
}

function gitExec(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

function setupFixture(label: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), `foundry-stand-in-${label}-`));
  const target = join(base, 'target');
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', target], { encoding: 'utf8' });
  gitExec(target, ['config', 'user.email', 'stand-in@example.com']);
  gitExec(target, ['config', 'user.name', 'Foundry Stand-In']);
  writeFileSync(join(target, '.gitignore'), '.agent\n');
  writeFileSync(join(target, 'README.md'), '# target\n');
  gitExec(target, ['add', '.gitignore', 'README.md']);
  gitExec(target, ['commit', '-m', 'initial']);
  gitExec(target, ['remote', 'add', 'origin', remote]);
  gitExec(target, ['push', '-u', 'origin', 'main']);
  const requestPath = join(base, 'request.md');
  writeFileSync(requestPath, '# Outcome\n\nMake the app observable.\n');
  const config = (publish: boolean): string => {
    const configPath = join(base, `foundry.config.${publish ? 'publish' : 'local'}.json`);
    writeFileSync(
      configPath,
      JSON.stringify({
        ...goldenConfigurationDocument(target, false),
        decisionPublication: publish
          ? { remote: 'origin', draft: true, maintainersCanModify: false }
          : null,
      }),
    );
    return configPath;
  };
  return {
    base,
    target,
    configPath: config(false),
    requestPath,
    config,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/**
 * Reports the configured publication remote as a GitHub repository so the local
 * bare origin can drive source provisioning while publication readiness still
 * evaluates as eligible.
 */
function publicationGit(): EffectLayer.Layer<ReadinessGit> {
  return Layer.effect(
    ReadinessGit,
    Effect.gen(function* () {
      const live = yield* ReadinessGit;
      return ReadinessGit.of({
        run: (args: ReadonlyArray<string>, cwd: string) =>
          args[0] === 'remote' && args[1] === 'get-url'
            ? Effect.succeed({ stdout: `${PUBLICATION_REMOTE_URL}\n`, exitCode: 0 })
            : live.run(args, cwd),
      });
    }),
  ).pipe(Layer.provide(ReadinessGitLive));
}

/**
 * Reports the configured publication remote as a GitHub repository to the
 * workflow's Git adapter, so the ordinary result and decision publication can
 * confirm the repository identity while every other Git operation stays real.
 */
function publicationRunGit(): EffectLayer.Layer<RunGit> {
  return Layer.effect(
    RunGit,
    Effect.gen(function* () {
      const live = yield* RunGit;
      return RunGit.of({
        ...live,
        inspectRepository: (options) =>
          Effect.succeed({
            repositoryRoot: options.repositoryRoot,
            gitDirectory: `${options.repositoryRoot}/.git`,
            remoteUrl: PUBLICATION_REMOTE_URL,
          }),
      });
    }),
  ).pipe(Layer.provide(RunGitLive));
}

interface StandInGitHubCalls {
  readonly push: Array<GitHubPushTaskBranchOptions>;
}

interface StandInGitHubHarness {
  readonly layer: EffectLayer.Layer<GitHubPublication>;
  readonly calls: StandInGitHubCalls;
}

/**
 * A stand-in GitHub adapter for walks whose configured publication is never
 * reached. It answers the repository identity and refuses every reachable
 * mutation loudly so an unexpected publication cannot pass silently.
 */
function standInDefaultPublication(): EffectLayer.Layer<GitHubPublication> {
  return Layer.succeed(
    GitHubPublication,
    GitHubPublication.of({
      lookupRepositoryIdentity: (options) => Effect.succeed({ repository: options.repository }),
      lookupExactPullRequest: () => Effect.die(new Error('no draft PR is expected for this run')),
      createDraftPullRequest: () => Effect.die(new Error('no draft PR is expected for this run')),
      openResultPullRequest: () => Effect.die(new Error('no result PR is expected for this run')),
      refreshOwnedDraftPullRequestBody: () =>
        Effect.die(new Error('no draft PR is expected for this run')),
      pushTaskBranch: () => Effect.die(new Error('no push is expected for this run')),
      listIssueCommentsAfter: () => Effect.succeed({ comments: [], truncated: false }),
      collaboratorPermission: () => Effect.succeed({ permission: 'maintain' }),
    }),
  );
}

/**
 * A deterministic GitHub adapter for an eligible human decision. It records the
 * non-force push and creates the one draft pull request for the task branch so
 * the publishing stage can reconcile the exact URL in place.
 */
function standInDraftPrPublication(): StandInGitHubHarness {
  const calls: StandInGitHubCalls = { push: [] };
  const pullRequestNumber = 9;
  const layer = Layer.succeed(
    GitHubPublication,
    GitHubPublication.of({
      lookupRepositoryIdentity: (options) => Effect.succeed({ repository: options.repository }),
      lookupExactPullRequest: () => Effect.succeed({ kind: 'absent' }),
      createDraftPullRequest: (options) =>
        Effect.succeed({
          number: pullRequestNumber,
          url: `${PUBLICATION_REMOTE_URL.replace(/\.git$/u, '')}/pull/${pullRequestNumber}`,
          draft: true,
          headBranch: options.headBranch,
          headCommit: options.headBranch,
          baseBranch: options.baseBranch,
        } satisfies GitHubPullRequest),
      openResultPullRequest: () => Effect.die(new Error('result publication must not open a PR')),
      refreshOwnedDraftPullRequestBody: () =>
        Effect.die(new Error('result publication must not refresh a draft PR')),
      pushTaskBranch: (options) => {
        calls.push.push(options);
        return Effect.void;
      },
      listIssueCommentsAfter: () => Effect.succeed({ comments: [], truncated: false }),
      collaboratorPermission: () => Effect.succeed({ permission: 'maintain' }),
    }),
  );
  return { layer, calls };
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
  publicationGit(),
  Layer.succeed(
    ProjectCommandProcess,
    ProjectCommandProcess.of({
      run: () => Effect.succeed({ exitCode: 0, stdout: '', stderr: '' }),
    }),
  ),
  ProjectCommandsPlatformLive,
  RunIdentityLive,
  RunHistoryLive,
  RepositoryLeaseLive,
  RoleTurnResourceObserverLive,
  GuidanceLive,
  Layer.succeed(
    PublicationProbe,
    PublicationProbe.of({
      observe: (request) =>
        Effect.succeed({
          repository: request.repository,
          tokenPresent: true,
          push: true,
          collaboratorPermission: 'admin',
          issueCommentReadable: true,
          tokenScopes: null,
          protectedBranches: ['main'],
          limitations: [],
        }),
    }),
  ),
);

interface RunOptions {
  readonly runId: string;
  readonly taskId: string;
  readonly publish?: boolean;
  readonly runGit?: EffectLayer.Layer<RunGit>;
  readonly github?: EffectLayer.Layer<GitHubPublication>;
}

function runWithHost(
  fixture: Fixture,
  options: RunOptions,
  host: EffectLayer.Layer<RoleHostLauncher>,
) {
  const configPath = options.publish === true ? fixture.config(true) : fixture.configPath;
  return runCli([
    'run',
    '--config',
    configPath,
    '--request',
    fixture.requestPath,
    '--task-id',
    options.taskId,
    '--run-id',
    options.runId,
    '--json',
  ]).pipe(
    Effect.provide(
      Layer.mergeAll(
        capabilityLayers,
        host,
        options.runGit ?? RunGitLive,
        options.github ?? standInDefaultPublication(),
      ),
    ),
  );
}

function runStandIn(fixture: Fixture, options: RunOptions, script: StandInRoleHostScript) {
  return runWithHost(fixture, options, standInRoleHost(script));
}

function readHistory(fixture: Fixture, runId: string) {
  return readVerifiedRunHistory({
    runDirectory: join(fixture.target, '.agent', 'runs', runId),
    runId,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

function readHandoff(fixture: Fixture, runId: string) {
  return Schema.decodeUnknownSync(HandoffDocumentJson)(
    readFileSync(join(fixture.target, '.agent', 'runs', runId, HANDOFF_FILENAME), 'utf8'),
  );
}

function workflowStateOf(stdout: string): string | null {
  const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(stdout);
  expect(envelope.ok).toBe(true);
  if (!envelope.ok || !('workflowState' in envelope.data)) {
    throw new Error(`Expected a run workflow envelope: ${stdout}`);
  }
  return envelope.data.workflowState;
}

function failureKindOf(stdout: string): string | null {
  const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(stdout);
  expect(envelope.ok).toBe(false);
  return envelope.ok ? null : envelope.error.kind;
}

function routesOf(history: VerifiedRunHistory): ReadonlyArray<string> {
  return history.events
    .filter((event) => event.type === 'workflow-transition')
    .map((event) => (event.type === 'workflow-transition' ? event.payload.route : ''));
}

const ARCHITECT_PLAN: StandInSettledTurn = {
  narrative: 'The plan is ready.',
  control: {
    schemaVersion: 1,
    outcome: 'plan_ready',
    acceptanceCriteria: ['the app is observable'],
    runtimeValidation: 'not_required',
    execution: 'sequential',
  },
};

const ARCHITECT_NO_CHANGE: StandInSettledTurn = {
  narrative: 'The frozen source already satisfies the request.',
  control: {
    schemaVersion: 1,
    outcome: 'no_change_candidate',
    acceptanceCriteria: ['the app is already observable'],
    runtimeValidation: 'not_required',
  },
};

const REVIEWER_APPROVE: StandInSettledTurn = {
  narrative: 'The changed commit satisfies the request.',
  control: { schemaVersion: 1, outcome: 'approved' },
};

function commitInWorkspace(observed: Array<StandInTurnContext>): StandInTurnAct {
  let commits = 0;
  return (context) =>
    Effect.sync(() => {
      observed.push(context);
      commits += 1;
      const name = `stand-in-change-${commits}.txt`;
      writeFileSync(join(context.workingDirectory, name), `stand-in change ${commits}\n`);
      execFileSync('git', ['-C', context.workingDirectory, 'add', name]);
      execFileSync('git', [
        '-C',
        context.workingDirectory,
        'commit',
        '-m',
        `stand-in change ${commits}`,
      ]);
    });
}

describe('stand-in role host protocol', () => {
  it.effect('attests a closed foundry-role-host-v1 capability envelope', () =>
    Effect.gen(function* () {
      const host = yield* RoleHost;
      const report = yield* host.capabilities({ schemaVersion: ROLE_HOST_PROTOCOL_VERSION });
      expect(
        Schema.decodeUnknownSync(RoleHostCapabilitiesResponseSchema, STRICT)(report),
      ).toMatchObject({ protocol: 'foundry-role-host-v1', resumable: true });
      expect(evaluateRoleHostCapabilities(report)).toEqual({ ok: true });
      expect(report.availableRoles).toEqual([
        'architect',
        'coder',
        'lead_coder',
        'tester',
        'reviewer',
      ]);
    }).pipe(Effect.provide(standInRoleHost())),
  );

  it.effect('serves closed settled and lost observe envelopes', () =>
    Effect.gen(function* () {
      const host = yield* RoleHost;
      const created = yield* host.create({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        runId: 'RUN-STANDIN-PROTOCOL',
        role: 'architect',
        attempt: 1,
        generation: 1,
        workingDirectory: '/work/target',
        readRoots: ['/work/target', '/work/target/.agent/runs/RUN-STANDIN-PROTOCOL'],
        writeRoots: ['/work/target/.agent/runs/RUN-STANDIN-PROTOCOL/scratch/architect/1'],
        networkAllowlist: [],
      });
      yield* host.submit({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        sessionId: created.sessionId,
        ownershipToken: created.ownershipToken,
        generation: created.generation,
        idempotencyKey: 'idem-1',
        prompt: 'Plan the change.',
        deadline: '2026-09-13T00:00:00.000Z',
      });
      const settled = yield* host.observe({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        sessionId: created.sessionId,
        ownershipToken: created.ownershipToken,
        generation: created.generation,
        afterSequence: 0,
      });
      if (settled.status !== 'settled') {
        throw new Error(`Expected a settled observation, received ${settled.status}.`);
      }
      expect(Schema.decodeUnknownSync(RoleHostObserveResponseSchema, STRICT)(settled)).toEqual(
        settled,
      );
      expect(settled.control).toMatchObject({ outcome: 'plan_ready' });
    }).pipe(Effect.provide(standInRoleHost())),
  );

  it.effect('refuses a create whose permission roots exceed the role profile', () =>
    Effect.gen(function* () {
      const host = yield* RoleHost;
      const base = {
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        runId: 'RUN-STANDIN-PERMISSIONS',
        generation: 1,
      } as const;
      const runDirectory = '/work/target/.agent/runs/RUN-STANDIN-PERMISSIONS';
      const worktree = '/work/target/.agent/worktrees/RUN-STANDIN-PERMISSIONS';
      const scratch = `${runDirectory}/scratch/architect/1`;

      const valid = [
        {
          ...base,
          role: 'architect',
          attempt: 1,
          workingDirectory: '/work/target',
          readRoots: ['/work/target', runDirectory],
          writeRoots: [scratch],
          networkAllowlist: [],
        },
        {
          ...base,
          role: 'coder',
          attempt: 1,
          workingDirectory: worktree,
          readRoots: [worktree, runDirectory],
          writeRoots: [worktree, scratch],
          networkAllowlist: [],
        },
        {
          ...base,
          role: 'tester',
          attempt: 1,
          workingDirectory: '/work/target',
          readRoots: ['/work/target', runDirectory],
          writeRoots: [`${runDirectory}/scratch/tester/1`],
          networkAllowlist: ['http://127.0.0.1:4200'],
        },
      ] as const;
      for (const request of valid) {
        const created = yield* host.create(request);
        expect(created.sessionId.length).toBeGreaterThan(0);
      }

      const invalid: ReadonlyArray<RoleHostCreateRequest> = [
        {
          ...base,
          role: 'architect',
          attempt: 2,
          workingDirectory: '/work/target',
          readRoots: ['/work/target', runDirectory],
          writeRoots: ['/work/target'],
          networkAllowlist: [],
        },
        {
          ...base,
          role: 'architect',
          attempt: 3,
          workingDirectory: '/work/target',
          readRoots: ['/work/target', runDirectory],
          writeRoots: [scratch],
          networkAllowlist: ['http://127.0.0.1:4200'],
        },
        {
          ...base,
          role: 'coder',
          attempt: 4,
          workingDirectory: worktree,
          readRoots: [worktree, runDirectory],
          writeRoots: [scratch],
          networkAllowlist: [],
        },
        {
          ...base,
          role: 'coder',
          attempt: 5,
          workingDirectory: worktree,
          readRoots: [worktree],
          writeRoots: [worktree, '/work/outside'],
          networkAllowlist: [],
        },
        {
          ...base,
          role: 'tester',
          attempt: 6,
          workingDirectory: '/work/target',
          readRoots: ['/work/target', runDirectory],
          writeRoots: [`${runDirectory}/scratch/tester/6`],
          networkAllowlist: [],
        },
      ];
      for (const request of invalid) {
        const error = yield* host.create(request).pipe(Effect.flip);
        expect(error.operation).toBe('create');
        expect(error.message.length).toBeGreaterThan(0);
      }
    }).pipe(Effect.provide(standInRoleHost())),
  );

  it.effect('defaults a scripted turn to a role-appropriate envelope', () =>
    Effect.gen(function* () {
      const host = yield* RoleHost;
      const created = yield* host.create({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        runId: 'RUN-STANDIN-DEFAULT',
        role: 'reviewer',
        attempt: 1,
        generation: 1,
        workingDirectory: '/work/target',
        readRoots: ['/work/target', '/work/target/.agent/runs/RUN-STANDIN-DEFAULT'],
        writeRoots: ['/work/target/.agent/runs/RUN-STANDIN-DEFAULT/scratch/reviewer/1'],
        networkAllowlist: [],
      });
      yield* host.submit({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        sessionId: created.sessionId,
        ownershipToken: created.ownershipToken,
        generation: created.generation,
        idempotencyKey: 'idem-1',
        prompt: 'Review the change.',
        deadline: '2026-09-13T00:00:00.000Z',
      });
      const settled = yield* host.observe({
        schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
        sessionId: created.sessionId,
        ownershipToken: created.ownershipToken,
        generation: created.generation,
        afterSequence: 0,
      });
      expect(settled.status).toBe('settled');
      if (settled.status === 'settled') {
        expect(settled.control).toMatchObject({ outcome: 'approved' });
      }
    }).pipe(Effect.provide(standInRoleHost())),
  );
});

describe('stand-in role host workflow walks', () => {
  it.live('drives a sequential changed request to completed with a Coder commit', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('approved');
      try {
        const runId = 'RUN-STANDIN-APPROVED';
        const taskId = 'TASK-STANDIN-APPROVED';
        const observed: Array<StandInTurnContext> = [];
        const result = yield* runStandIn(
          fixture,
          { runId, taskId },
          {
            architect: ARCHITECT_PLAN,
            coder: {
              narrative: 'Implemented the change.',
              control: { schemaVersion: 1, outcome: 'implemented' },
              act: commitInWorkspace(observed),
            },
            reviewer: REVIEWER_APPROVE,
          },
        );
        expect(result.exitCode).toBe(0);
        expect(workflowStateOf(result.stdout)).toBe('completed');

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('completed');
        expect(routesOf(history)).toContain('review-approved');
        const commit = history.derived.implementation?.commit ?? null;
        expect(commit).not.toBeNull();
        expect(observed).toHaveLength(1);
        if (commit === null) {
          throw new Error('Expected a recorded implementation commit.');
        }
        expect(gitExec(fixture.target, ['rev-parse', `foundry/${taskId}`]).trim()).toBe(commit);
        expect(gitExec(fixture.target, ['show', '--name-only', '--format=', commit])).toContain(
          'stand-in-change-1.txt',
        );
        expect(gitExec(fixture.target, ['status', '--porcelain']).trim()).toBe('');
        expect(existsSync(join(fixture.target, '.agent', 'worktrees', taskId))).toBe(false);

        const handoff = readHandoff(fixture, runId);
        expect(handoff.kind).toBe('change');
        expect(handoff.resultCommit).toBe(commit);
        expect(handoff.publication.created).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('keeps a changed Coder commit inside the run-owned workspace', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('workspace');
      try {
        const runId = 'RUN-STANDIN-WORKSPACE';
        const taskId = 'TASK-STANDIN-WORKSPACE';
        const observed: Array<StandInTurnContext> = [];
        const workspace = join(fixture.target, '.agent', 'worktrees', taskId);
        const result = yield* runStandIn(
          fixture,
          { runId, taskId },
          {
            architect: ARCHITECT_PLAN,
            coder: {
              narrative: 'Implemented the change.',
              control: { schemaVersion: 1, outcome: 'implemented' },
              act: commitInWorkspace(observed),
            },
            reviewer: REVIEWER_APPROVE,
          },
        );
        expect(result.exitCode).toBe(0);
        expect(observed.map((context) => context.workingDirectory)).toEqual([workspace]);
        expect(observed[0]?.writeRoots).toContain(workspace);
        expect(observed[0]?.networkAllowlist).toEqual([]);
        expect(gitExec(fixture.target, ['status', '--porcelain']).trim()).toBe('');
        expect(gitExec(fixture.target, ['log', '--oneline', 'main'])).not.toContain(
          'stand-in-change',
        );
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live(
    'records a project-mutation violation when a read-only turn changes production files',
    () =>
      Effect.gen(function* () {
        const fixture = setupFixture('violation');
        try {
          const runId = 'RUN-STANDIN-VIOLATION';
          const taskId = 'TASK-STANDIN-VIOLATION';
          const result = yield* runStandIn(
            fixture,
            { runId, taskId },
            {
              architect: {
                ...ARCHITECT_PLAN,
                act: () =>
                  Effect.sync(() => {
                    writeFileSync(join(fixture.target, 'evil.ts'), 'export const evil = true;\n');
                  }),
              },
              coder: {
                narrative: 'Implemented the change.',
                control: { schemaVersion: 1, outcome: 'implemented' },
                act: commitInWorkspace([]),
              },
              reviewer: REVIEWER_APPROVE,
            },
          );
          expect(result.exitCode).toBe(1);
          expect(failureKindOf(result.stdout)).toBe('blocked');

          const history = yield* readHistory(fixture, runId);
          expect(history.derived.state).toBe('blocked');
          expect(history.derived.permissionViolations).toHaveLength(1);
          expect(history.derived.permissionViolations[0]?.kind).toBe('project-mutation');
          expect(history.derived.roleSessions.some((session) => session.role === 'coder')).toBe(
            false,
          );
          expect(routesOf(history)).toContain('block-run');
        } finally {
          fixture.cleanup();
        }
      }),
  );

  it.live('changes nothing about completion or publication when the host Layer is swapped', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('swap');
      try {
        const script: StandInRoleHostScript = {
          architect: ARCHITECT_NO_CHANGE,
          reviewer: REVIEWER_APPROVE,
        };
        const standIn = yield* runStandIn(
          fixture,
          { runId: 'RUN-STANDIN-SWAP-A', taskId: 'TASK-STANDIN-SWAP-A' },
          script,
        );
        const processLike = yield* runWithHost(
          fixture,
          { runId: 'RUN-STANDIN-SWAP-B', taskId: 'TASK-STANDIN-SWAP-B' },
          scriptedRoleHostLauncher({
            architect: {
              narrative: 'The frozen source already satisfies the request.',
              control: ARCHITECT_NO_CHANGE.control,
            },
            reviewer: REVIEWER_APPROVE,
          }),
        );
        expect(standIn.exitCode).toBe(0);
        expect(processLike.exitCode).toBe(0);
        expect(workflowStateOf(standIn.stdout)).toBe('completed_no_change');
        expect(workflowStateOf(processLike.stdout)).toBe('completed_no_change');

        const standInHistory = yield* readHistory(fixture, 'RUN-STANDIN-SWAP-A');
        const processLikeHistory = yield* readHistory(fixture, 'RUN-STANDIN-SWAP-B');
        expect(standInHistory.derived.state).toBe(processLikeHistory.derived.state);
        expect(routesOf(standInHistory)).toEqual(routesOf(processLikeHistory));

        const standInHandoff = readHandoff(fixture, 'RUN-STANDIN-SWAP-A');
        const processLikeHandoff = readHandoff(fixture, 'RUN-STANDIN-SWAP-B');
        expect(standInHandoff.publication.created).toBe(processLikeHandoff.publication.created);
        expect(standInHandoff.publication.created).toBe(false);
        expect(standInHandoff.kind).toBe(processLikeHandoff.kind);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('fails an outstanding stand-in session as lost-session and blocks', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('lost');
      try {
        const runId = 'RUN-STANDIN-LOST';
        const result = yield* runStandIn(
          fixture,
          { runId, taskId: 'TASK-STANDIN-LOST' },
          { architect: { status: 'lost' } },
        );
        expect(result.exitCode).toBe(1);
        expect(failureKindOf(result.stdout)).toBe('blocked');

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('blocked');
        const lost = history.events.filter(
          (event) => event.type === 'role-session-observed' && event.payload.status === 'lost',
        );
        expect(lost.length).toBeGreaterThan(0);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('blocks on an invalid stand-in envelope after the bounded repair and retry', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('invalid');
      try {
        const runId = 'RUN-STANDIN-INVALID';
        const result = yield* runStandIn(
          fixture,
          { runId, taskId: 'TASK-STANDIN-INVALID' },
          {
            architect: {
              narrative: 'The plan control cannot be decoded.',
              control: { schemaVersion: 1, outcome: 'bogus' },
            },
          },
        );
        expect(result.exitCode).toBe(1);
        expect(failureKindOf(result.stdout)).toBe('blocked');

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('blocked');
        expect(
          history.derived.attempts.filter(
            (attempt) => attempt.role === 'architect' && attempt.kind === 'retry',
          ),
        ).toHaveLength(1);
        expect(
          history.derived.roleSessions.filter((session) => session.role === 'architect'),
        ).toHaveLength(2);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('blocks a stand-in Reviewer blocked outcome with evidence preserved', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('blocked');
      try {
        const runId = 'RUN-STANDIN-BLOCKED';
        const result = yield* runStandIn(
          fixture,
          { runId, taskId: 'TASK-STANDIN-BLOCKED' },
          {
            architect: ARCHITECT_PLAN,
            coder: {
              narrative: 'Implemented the change.',
              control: { schemaVersion: 1, outcome: 'implemented' },
              act: commitInWorkspace([]),
            },
            reviewer: {
              narrative: 'Reviewer cannot safely review.',
              control: { schemaVersion: 1, outcome: 'blocked' },
            },
          },
        );
        expect(result.exitCode).toBe(1);
        expect(failureKindOf(result.stdout)).toBe('blocked');

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('blocked');
        expect(routesOf(history)).toContain('block-run');
        expect(history.derived.roleSessions.some((session) => session.role === 'reviewer')).toBe(
          true,
        );
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('applies the same publication policy to an eligible human-decision outcome', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('human');
      try {
        const runId = 'RUN-STANDIN-HUMAN';
        const github = standInDraftPrPublication();
        const result = yield* runStandIn(
          fixture,
          {
            runId,
            taskId: 'TASK-STANDIN-HUMAN',
            publish: true,
            runGit: publicationRunGit(),
            github: github.layer,
          },
          {
            architect: ARCHITECT_PLAN,
            coder: {
              narrative: 'Implemented the change.',
              control: { schemaVersion: 1, outcome: 'implemented' },
              act: commitInWorkspace([]),
            },
            reviewer: {
              narrative: 'A product decision is required.',
              control: {
                schemaVersion: 1,
                outcome: 'human_decision_required',
                decision: {
                  question: 'Should the stricter bound remain?',
                  options: [
                    { label: 'Keep it', action: 'accept' },
                    { label: 'Relax it', action: 'correct' },
                  ],
                },
              },
            },
          },
        );
        expect(result.exitCode).toBe(0);
        expect(workflowStateOf(result.stdout)).toBe('human_decision_required');

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('human_decision_required');
        expect(routesOf(history)).toContain('human-decision-required');
        expect(routesOf(history)).toContain('draft-pr-reconciled');
        expect(routesOf(history)).not.toContain('publication-unavailable');
        expect(github.calls.push).toHaveLength(1);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('blocks a human-decision outcome when publication is not configured', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('unconfigured');
      try {
        const runId = 'RUN-STANDIN-UNCONFIGURED';
        const result = yield* runStandIn(
          fixture,
          { runId, taskId: 'TASK-STANDIN-UNCONFIGURED' },
          {
            architect: ARCHITECT_PLAN,
            coder: {
              narrative: 'Implemented the change.',
              control: { schemaVersion: 1, outcome: 'implemented' },
              act: commitInWorkspace([]),
            },
            reviewer: {
              narrative: 'A product decision is required.',
              control: {
                schemaVersion: 1,
                outcome: 'human_decision_required',
                decision: {
                  question: 'Should the stricter bound remain?',
                  options: [
                    { label: 'Keep it', action: 'accept' },
                    { label: 'Relax it', action: 'correct' },
                  ],
                },
              },
            },
          },
        );
        expect(result.exitCode).toBe(1);
        expect(failureKindOf(result.stdout)).toBe('blocked');

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('blocked');
        expect(routesOf(history)).toContain('publication-unavailable');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('stand-in host capability default', () => {
  it('reports every role and capability profile a live host must attest', () => {
    expect(evaluateRoleHostCapabilities(STAND_IN_ROLE_HOST_CAPABILITIES)).toEqual({ ok: true });
  });
});
