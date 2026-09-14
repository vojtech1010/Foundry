import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitHubPublication } from '../src/application/decision-publication/index.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { ReportEnvelope, runCli } from '../src/cli/program.js';
import { ProjectCommandProcess } from '../src/application/profile-check/index.js';
import {
  PublicationProbe,
  ReadinessGit,
  ReadinessHost,
} from '../src/application/readiness/index.js';
import { RoleHost, RoleHostLauncher } from '../src/application/role-conversations/index.js';
import { HANDOFF_FILENAME, HandoffDocumentSchema } from '../src/application/handoff/index.js';
import { ROLE_HOST_PROTOCOL_VERSION } from '../src/domain/role-host.js';
import { WORKFLOW_TRANSITION_ROUTES, allowsWorkflowRouteFrom } from '../src/domain/workflow.js';
import { GuidanceLive } from '../src/platform/guidance.js';
import { RunGitLive } from '../src/platform/git-provisioning.js';
import { ProjectCommandsPlatformLive } from '../src/platform/project-commands.js';
import { ReadinessFilesLive, ReadinessGitLive } from '../src/platform/readiness.js';
import { RepositoryLeaseLive } from '../src/platform/repository-lease.js';
import { RoleTurnResourceObserverLive } from '../src/platform/role-permissions.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import { goldenConfigurationDocument } from './fixtures/checks-runtime-run.js';
import { CAPABLE_ROLE_HOST_CAPABILITIES } from './fixtures/role-host/role-host-launcher.js';

import type { Schema as EffectSchema } from 'effect';
import type { RoleHostRole } from '../src/domain/role-host.js';
import type { RunEvent } from '../src/domain/run-history.js';
import type { VerifiedRunHistory } from '../src/application/run-history/index.js';
import type {
  GitHubCreatePullRequestOptions,
  GitHubPullRequest,
  GitHubPushTaskBranchOptions,
} from '../src/application/decision-publication/index.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

const HandoffDocumentJson = Schema.fromJsonString(HandoffDocumentSchema);

const TASK_ID = 'TASK-ROUTING';

const PUBLICATION_REMOTE_URL = 'https://github.com/example/target.git';

interface RoutingTurn {
  readonly narrative: string;
  readonly control: EffectSchema.JsonObject;
}

type ScriptedTurns = Partial<Record<RoleHostRole, RoutingTurn | RoutingTurn[]>>;

interface Fixture {
  readonly base: string;
  readonly target: string;
  readonly configPath: string;
  readonly requestPath: string;
  readonly workspace: string;
  readonly cleanup: () => void;
}

function gitExec(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' });
}

function setupFixture(label: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), `foundry-routing-${label}-`));
  const target = join(base, 'target');
  const remote = join(base, 'remote.git');
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', target], { encoding: 'utf8' });
  gitExec(target, ['config', 'user.email', 'routing@example.com']);
  gitExec(target, ['config', 'user.name', 'Foundry Routing']);
  writeFileSync(join(target, '.gitignore'), '.agent\n');
  writeFileSync(join(target, 'README.md'), '# target\n');
  gitExec(target, ['add', '.gitignore', 'README.md']);
  gitExec(target, ['commit', '-m', 'initial']);
  gitExec(target, ['remote', 'add', 'origin', remote]);
  gitExec(target, ['push', '-u', 'origin', 'main']);
  const configPath = join(base, 'foundry.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      ...goldenConfigurationDocument(target, true),
      decisionPublication: { remote: 'origin', draft: true, maintainersCanModify: false },
    }),
  );
  const requestPath = join(base, 'request.md');
  writeFileSync(requestPath, '# Outcome\n\nMake the app observable.\n');
  return {
    base,
    target,
    configPath,
    requestPath,
    workspace: join(target, '.agent', 'worktrees', TASK_ID),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

function selectTurn(
  configured: RoutingTurn | RoutingTurn[] | undefined,
  role: RoleHostRole,
  index: number,
): RoutingTurn {
  const fallback = defaultTurnFor(role);
  if (configured === undefined) {
    return fallback;
  }
  if (Array.isArray(configured)) {
    return configured[Math.min(index, configured.length - 1)] ?? fallback;
  }
  return configured;
}

function defaultTurnFor(role: RoleHostRole): RoutingTurn {
  return {
    narrative: `${role} settled.`,
    control: { schemaVersion: 1, outcome: 'approved' },
  };
}

/**
 * A deterministic role host for the routing walkthroughs. It settles every
 * session with the scripted control for its role and, when configured, makes a
 * real commit on the assigned Coder worktree so approved results carry a
 * Git-derived changed commit.
 */
function routingRoleHostLauncher(
  turns: ScriptedTurns,
  options: { readonly commitOnCoder: boolean },
): Layer.Layer<RoleHostLauncher> {
  const roles = new Map<string, RoleHostRole>();
  const counters = new Map<RoleHostRole, number>();
  let commits = 0;
  const hostLayer = Layer.succeed(
    RoleHost,
    RoleHost.of({
      capabilities: () => Effect.succeed(CAPABLE_ROLE_HOST_CAPABILITIES),
      create: (request) =>
        Effect.sync(() => {
          const sessionId = `session-${request.role}-${request.attempt}-${request.generation}`;
          roles.set(sessionId, request.role);
          const workspace = request.workingDirectory;
          if (request.role === 'coder' && options.commitOnCoder && workspace !== undefined) {
            commits += 1;
            const name = `routing-change-${commits}.txt`;
            writeFileSync(join(workspace, name), `routing change ${commits}\n`);
            execFileSync('git', ['-C', workspace, 'add', name]);
            execFileSync('git', ['-C', workspace, 'commit', '-m', `routing change ${commits}`]);
          }
          return {
            schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
            sessionId,
            ownershipToken: `owner-${sessionId}`,
            generation: request.generation,
            sequence: 0,
            runtimeIdentity: {
              adapterVersion: 'routing-1',
              provider: 'routing',
              model: 'routing',
              toolProfile: 'routing',
            },
          };
        }),
      submit: () =>
        Effect.succeed({
          schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          submission: 'accepted',
        }),
      observe: (request) =>
        Effect.sync(() => {
          const role = roles.get(request.sessionId) ?? 'architect';
          const index = counters.get(role) ?? 0;
          counters.set(role, index + 1);
          const turn = selectTurn(turns[role], role, index);
          return {
            schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
            status: 'settled' as const,
            sequence: request.afterSequence + 1,
            events: [],
            narrative: turn.narrative,
            control: turn.control,
          };
        }),
      stop: () =>
        Effect.succeed({
          schemaVersion: ROLE_HOST_PROTOCOL_VERSION,
          disposition: 'disposed',
        }),
    }),
  );
  return Layer.succeed(RoleHostLauncher, RoleHostLauncher.of({ launch: () => hostLayer }));
}

/**
 * Reports the configured publication remote as a GitHub repository so the
 * local bare origin can drive source provisioning while publication readiness
 * still evaluates as eligible.
 */
function publicationGit(): Layer.Layer<ReadinessGit> {
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

/**
 * Reports the configured publication remote as a GitHub repository to the
 * workflow's Git adapter, so the ordinary result publication can confirm the
 * repository identity while every other Git operation stays real.
 */
function publicationRunGit(): Layer.Layer<RunGit> {
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

interface RoutingOverrides {
  readonly runGit?: Layer.Layer<RunGit>;
  readonly github?: Layer.Layer<GitHubPublication>;
}

interface RoutingGitHubCalls {
  readonly open: Array<GitHubCreatePullRequestOptions>;
  readonly push: Array<GitHubPushTaskBranchOptions>;
}

interface RoutingGitHubHarness {
  readonly layer: Layer.Layer<GitHubPublication>;
  readonly calls: RoutingGitHubCalls;
}

/**
 * A minimal GitHub publication adapter for the green-path routing walk. It
 * records the non-force push and returns the one ordinary (non-draft) result
 * pull request for the task branch, resolving the branch head from the real
 * repository so the publication can confirm the exact accepted commit.
 */
function routingGitHubPublication(fixture: Fixture): RoutingGitHubHarness {
  const calls: RoutingGitHubCalls = { open: [], push: [] };
  const pullRequestNumber = 42;
  const layer = Layer.succeed(
    GitHubPublication,
    GitHubPublication.of({
      lookupRepositoryIdentity: (options) => Effect.succeed({ repository: options.repository }),
      lookupExactPullRequest: () =>
        Effect.die(new Error('result publication must not look up a draft PR')),
      createDraftPullRequest: () =>
        Effect.die(new Error('result publication must not create a draft PR')),
      openResultPullRequest: (options) => {
        calls.open.push(options);
        return Effect.sync(() => {
          const headCommit = gitExec(fixture.target, [
            'rev-parse',
            `refs/heads/${options.headBranch}`,
          ]).trim();
          return {
            number: pullRequestNumber,
            url: `${PUBLICATION_REMOTE_URL.replace(/\.git$/u, '')}/pull/${pullRequestNumber}`,
            draft: false,
            headBranch: options.headBranch,
            headCommit,
            baseBranch: options.baseBranch,
          } satisfies GitHubPullRequest;
        });
      },
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

function runRouting(
  fixture: Fixture,
  runId: string,
  turns: ScriptedTurns,
  commitOnCoder: boolean,
  overrides: RoutingOverrides = {},
) {
  return runCli([
    'run',
    '--config',
    fixture.configPath,
    '--request',
    fixture.requestPath,
    '--task-id',
    TASK_ID,
    '--run-id',
    runId,
    '--json',
  ]).pipe(
    Effect.provide(
      Layer.mergeAll(
        capabilityLayers,
        routingRoleHostLauncher(turns, { commitOnCoder }),
        overrides.runGit ?? RunGitLive,
        overrides.github ?? Layer.empty,
      ),
    ),
  );
}

function readHistory(fixture: Fixture, runId: string) {
  return readVerifiedRunHistory({
    runDirectory: join(fixture.target, '.agent', 'runs', runId),
    runId,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

function transitions(history: VerifiedRunHistory): ReadonlyArray<RunEvent> {
  return history.events.filter((event) => event.type === 'workflow-transition');
}

function routesOf(history: VerifiedRunHistory): ReadonlyArray<string> {
  return transitions(history).map((event) =>
    event.type === 'workflow-transition' ? event.payload.route : '',
  );
}

function expectRoute(history: VerifiedRunHistory, route: string, to: string): void {
  const matching = transitions(history).filter(
    (event) => event.type === 'workflow-transition' && event.payload.route === route,
  );
  expect(matching.length, `expected route ${route}`).toBeGreaterThan(0);
  expect(
    matching.some((event) => event.type === 'workflow-transition' && event.payload.to === to),
  ).toBe(true);
}

function workflowStateOf(stdout: string): string | null {
  const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(stdout);
  expect(envelope.ok).toBe(true);
  if (!envelope.ok || !('workflowState' in envelope.data)) {
    throw new Error(`Expected a run workflow envelope: ${stdout}`);
  }
  return envelope.data.workflowState;
}

const ROUTING_ARCHITECT: RoutingTurn = {
  narrative: 'The plan is ready.',
  control: {
    schemaVersion: 1,
    outcome: 'plan_ready',
    acceptanceCriteria: ['the app is observable'],
    runtimeValidation: 'not_required',
    execution: 'sequential',
  },
};

const ROUTING_ARCHITECT_RUNTIME: RoutingTurn = {
  narrative: 'The plan requires runtime validation.',
  control: {
    schemaVersion: 1,
    outcome: 'plan_ready',
    acceptanceCriteria: ['the app is observable'],
    runtimeValidation: 'required',
    execution: 'sequential',
  },
};

describe('automatic routing after review', () => {
  it.live('completes a changed approval in one run invocation and disposes once', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('approved');
      try {
        const runId = 'RUN-ROUTE-APPROVED';
        const result = yield* runRouting(
          fixture,
          runId,
          {
            architect: ROUTING_ARCHITECT,
            coder: {
              narrative: 'Implemented the change.',
              control: { schemaVersion: 1, outcome: 'implemented' },
            },
            reviewer: {
              narrative: 'The changed commit satisfies the request.',
              control: { schemaVersion: 1, outcome: 'approved' },
            },
          },
          true,
        );
        expect(result.exitCode).toBe(0);
        expect(workflowStateOf(result.stdout)).toBe('completed');

        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        if (!envelope.ok || !('request' in envelope.data) || !('workflowState' in envelope.data)) {
          throw new Error(`Expected a run workflow envelope: ${result.stdout}`);
        }
        // Publication is configured but no GitHub adapter is wired, so the
        // ordinary result PR is reported as not opened without failing the run.
        expect(envelope.data.resultPullRequest ?? null).toBeNull();

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('completed');
        expect(history.derived.implementation?.commit ?? null).not.toBeNull();
        expect(history.derived.resultPrRecorded ?? null).toBeNull();
        expect(history.events.some((event) => event.type === 'result-pr-recorded')).toBe(false);
        expectRoute(history, 'review-approved', 'completed');
        expect(routesOf(history)).toContain('implementation-ready');

        const cleanupEvents = history.events.filter((event) => event.type === 'cleanup-progress');
        expect(cleanupEvents).toHaveLength(1);
        expect(history.derived.cleanupProgress?.outcome).toBe('succeeded');
        expect(
          history.derived.roleSessions.every((session) => session.stopDisposition !== null),
        ).toBe(true);
        expect(existsSync(fixture.workspace)).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('publishes an approved changed result as an ordinary result PR', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('result-pr');
      try {
        const runId = 'RUN-ROUTE-RESULTPR';
        const github = routingGitHubPublication(fixture);
        const result = yield* runRouting(
          fixture,
          runId,
          {
            architect: ROUTING_ARCHITECT,
            coder: {
              narrative: 'Implemented the change.',
              control: { schemaVersion: 1, outcome: 'implemented' },
            },
            reviewer: {
              narrative: 'The changed commit satisfies the request.',
              control: { schemaVersion: 1, outcome: 'approved' },
            },
          },
          true,
          { runGit: publicationRunGit(), github: github.layer },
        );
        expect(result.exitCode).toBe(0);
        expect(workflowStateOf(result.stdout)).toBe('completed');

        const expectedUrl = 'https://github.com/example/target/pull/42';
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        if (!envelope.ok || !('request' in envelope.data) || !('workflowState' in envelope.data)) {
          throw new Error(`Expected a run workflow envelope: ${result.stdout}`);
        }
        expect(envelope.data.resultPullRequest).toBe(expectedUrl);

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('completed');
        const resultCommit = history.derived.implementation?.commit ?? null;
        expect(resultCommit).not.toBeNull();
        expect(history.derived.resultPrRecorded).toEqual({
          url: expectedUrl,
          commit: resultCommit,
          taskBranch: history.derived.worktreeReady?.taskBranch,
        });
        expect(history.events.filter((event) => event.type === 'result-pr-recorded')).toHaveLength(
          1,
        );
        expect(github.calls.push).toHaveLength(1);
        expect(github.calls.push[0]?.commit).toBe(resultCommit);
        expect(github.calls.open).toHaveLength(1);

        const handoff = Schema.decodeUnknownSync(HandoffDocumentJson)(
          readFileSync(join(fixture.target, '.agent', 'runs', runId, HANDOFF_FILENAME), 'utf8'),
        );
        expect(handoff.kind).toBe('change');
        expect(handoff.publication.created).toBe(true);
        expect(handoff.publication.kind).toBe('result');
        expect(handoff.publication.url).toBe(expectedUrl);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('routes changes_requested into a bounded correction and back to approval', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('changes');
      try {
        const runId = 'RUN-ROUTE-CHANGES';
        const result = yield* runRouting(
          fixture,
          runId,
          {
            architect: ROUTING_ARCHITECT,
            coder: {
              narrative: 'Implemented the change.',
              control: { schemaVersion: 1, outcome: 'implemented' },
            },
            reviewer: [
              {
                narrative: 'Handle the empty state.',
                control: { schemaVersion: 1, outcome: 'changes_requested' },
              },
              {
                narrative: 'The corrected commit satisfies the request.',
                control: { schemaVersion: 1, outcome: 'approved' },
              },
            ],
          },
          true,
        );
        expect(result.exitCode).toBe(0);
        expect(workflowStateOf(result.stdout)).toBe('completed');

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('completed');
        expectRoute(history, 'correction-required', 'correcting');
        expectRoute(history, 'review-approved', 'completed');
        expect(routesOf(history)).toContain('implementation-ready');
        const coderSessions = history.derived.roleSessions.filter(
          (session) => session.role === 'coder',
        );
        expect(coderSessions).toHaveLength(2);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('routes a bounded retest_requested back through testing before approval', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('retest');
      try {
        const runId = 'RUN-ROUTE-RETEST';
        const result = yield* runRouting(
          fixture,
          runId,
          {
            architect: ROUTING_ARCHITECT_RUNTIME,
            coder: {
              narrative: 'Implemented the change.',
              control: { schemaVersion: 1, outcome: 'implemented' },
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
          },
          true,
        );
        expect(result.exitCode).toBe(0);
        expect(workflowStateOf(result.stdout)).toBe('completed');

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('completed');
        expectRoute(history, 'retest-requested', 'testing');
        expectRoute(history, 'review-approved', 'completed');
        expect(
          history.derived.roleSessions.filter((session) => session.role === 'tester'),
        ).toHaveLength(2);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('routes an eligible human_decision_required into publishing', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('human');
      try {
        const runId = 'RUN-ROUTE-HUMAN';
        const result = yield* runRouting(
          fixture,
          runId,
          {
            architect: ROUTING_ARCHITECT,
            coder: {
              narrative: 'Implemented the change.',
              control: { schemaVersion: 1, outcome: 'implemented' },
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
          true,
        );
        // The eligible decision routes into the publishing stage in the same
        // invocation; the publication transaction itself is a later slice.
        expect(result.exitCode).toBe(0);
        expect(workflowStateOf(result.stdout)).toBe('publishing');

        const history = yield* readHistory(fixture, runId);
        expectRoute(history, 'human-decision-required', 'publishing');
        expect(routesOf(history)).not.toContain('publication-unavailable');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('stops a blocked Reviewer outcome with evidence preserved', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('blocked');
      try {
        const runId = 'RUN-ROUTE-BLOCKED';
        const result = yield* runRouting(
          fixture,
          runId,
          {
            architect: ROUTING_ARCHITECT,
            coder: {
              narrative: 'Implemented the change.',
              control: { schemaVersion: 1, outcome: 'implemented' },
            },
            reviewer: {
              narrative: 'Reviewer cannot safely review.',
              control: { schemaVersion: 1, outcome: 'blocked' },
            },
          },
          true,
        );
        expect(result.exitCode).toBe(1);

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('blocked');
        expectRoute(history, 'block-run', 'blocked');
        expect(history.derived.roleSessions.some((session) => session.role === 'reviewer')).toBe(
          true,
        );
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.live('completes a no-change approval with no result commit and no publication', () =>
    Effect.gen(function* () {
      const fixture = setupFixture('no-change');
      try {
        const runId = 'RUN-ROUTE-NOCHANGE';
        const result = yield* runRouting(
          fixture,
          runId,
          {
            architect: ROUTING_ARCHITECT,
            coder: {
              narrative: 'No implementation change is required.',
              control: { schemaVersion: 1, outcome: 'no_change_candidate' },
            },
            reviewer: {
              narrative: 'The verified source already satisfies the request.',
              control: { schemaVersion: 1, outcome: 'approved' },
            },
          },
          false,
        );
        expect(result.exitCode).toBe(0);
        expect(workflowStateOf(result.stdout)).toBe('completed_no_change');

        const history = yield* readHistory(fixture, runId);
        expect(history.derived.state).toBe('completed_no_change');
        expect(history.derived.implementation?.commit ?? null).toBeNull();
        expectRoute(history, 'review-approved-no-change', 'completed_no_change');
        expect(routesOf(history)).not.toContain('human-decision-required');
        expect(routesOf(history)).not.toContain('review-approved');

        const handoff = Schema.decodeUnknownSync(HandoffDocumentJson)(
          readFileSync(join(fixture.target, '.agent', 'runs', runId, HANDOFF_FILENAME), 'utf8'),
        );
        expect(handoff.kind).toBe('no_change');
        expect(handoff.resultCommit).toBeNull();
        expect(handoff.publication.created).toBe(false);
        expect(handoff.publication.kind).toBe('none');
        expect(handoff.publication.url).toBeNull();
        expect(history.derived.cleanupProgress?.outcome).toBe('succeeded');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('reviewer routing honors the legal transition table', () => {
  const observedRoutes = [
    { route: 'review-approved', from: 'reviewing', to: 'completed' },
    { route: 'review-approved-no-change', from: 'reviewing', to: 'completed_no_change' },
    { route: 'review-requested-implementation', from: 'reviewing', to: 'coding' },
    { route: 'correction-required', from: 'reviewing', to: 'correcting' },
    { route: 'retest-requested', from: 'reviewing', to: 'testing' },
    { route: 'human-decision-required', from: 'reviewing', to: 'publishing' },
    { route: 'publication-unavailable', from: 'reviewing', to: 'blocked' },
    { route: 'block-run', from: 'reviewing', to: 'blocked' },
    { route: 'fail-run', from: 'reviewing', to: 'failed' },
  ] as const;

  it('only uses routes defined in WORKFLOW_TRANSITION_ROUTES', () => {
    for (const observed of observedRoutes) {
      const definition = WORKFLOW_TRANSITION_ROUTES[observed.route];
      expect(definition.to).toBe(observed.to);
      expect(allowsWorkflowRouteFrom(definition.from, observed.from)).toBe(true);
    }
  });
});
