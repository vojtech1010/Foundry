import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GitHubPublication } from '../src/application/decision-publication/index.js';
import { RunGit } from '../src/application/git-provisioning/index.js';
import { decodeProjectConfiguration } from '../src/application/project-configuration.js';
import { ProjectCommandProcess } from '../src/application/profile-check/index.js';
import {
  PublicationProbe,
  ReadinessGit,
  ReadinessHost,
} from '../src/application/readiness/index.js';
import { appendRunEvent, readVerifiedRunHistory } from '../src/application/run-history/index.js';
import { advanceRun } from '../src/application/run-workflow/index.js';
import { RoleHost, RoleHostLauncher } from '../src/application/role-conversations/index.js';
import { standInRoleHost } from '../src/application/stand-in-role-host/index.js';
import { ReportEnvelope, runCli } from '../src/cli/program.js';
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

import type { Layer as EffectLayer } from 'effect';
import type { ProjectConfiguration } from '../src/domain/project-configuration.js';
import type { RunEvent, RunEventDraft } from '../src/domain/run-history.js';
import type { ImplementationObservation } from '../src/application/git-provisioning/index.js';
import type { GitCommandResult } from '../src/application/readiness/index.js';
import type { StandInRoleHostScript } from '../src/application/stand-in-role-host/index.js';

const ReportEnvelopeJson = Schema.fromJsonString(ReportEnvelope);

const RUN_ID = 'RUN-PUB-ROUTING';

const FROZEN_COMMIT = 'a'.repeat(40);

const RESULT_COMMIT = 'b'.repeat(40);

const REMOTE_SOURCE_COMMIT = 'c'.repeat(40);

const TASK_BRANCH = `foundry/${RUN_ID}`;

const WORKSPACE = `/target/.agent/worktrees/${RUN_ID}`;

const REPOSITORY = 'example/target';

const REMOTE_URL = `git@github.com:${REPOSITORY}.git`;

const PUBLICATION_REMOTE_URL = `https://github.com/${REPOSITORY}.git`;

const GOLDEN_AGGREGATE_HASH = 'f'.repeat(64);

function emit(runDirectory: string, createIfMissing: boolean, draft: RunEventDraft) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing,
    build: () => Effect.succeed(draft),
  }).pipe(Effect.provide(RunHistoryLive));
}

function verificationReport() {
  return {
    attempt: 1,
    repository: '/target',
    commit: RESULT_COMMIT,
    profileHash: 'd'.repeat(64),
    commandMs: 1000,
    executions: [
      {
        kind: 'gate' as const,
        name: 'formatCheck',
        executable: 'fmt',
        arguments: ['--check'],
        expectedExitCode: 0,
        actualExitCode: 0,
        timedOut: false,
        durationMs: 1,
        log: {
          path: '/evidence/formatCheck.log',
          sha256: 'e'.repeat(64),
          byteLength: 0,
          retainedByteLength: 0,
          truncated: false,
          redactionCount: 0,
        },
        trackedMutation: null,
        reconstructed: false,
        reconstructionError: null,
      },
    ],
    result: 'passed' as const,
  };
}

function seedProvenance(runDirectory: string, runtimeValidationRequired = false) {
  return Effect.gen(function* () {
    yield* emit(runDirectory, true, {
      type: 'run-created',
      payload: { taskId: 'TASK-PUB-ROUTING' },
    });
    yield* emit(runDirectory, false, {
      type: 'source-frozen',
      payload: {
        repository: {
          repositoryRoot: '/target',
          gitDirectory: '/target/.git',
          remoteUrl: REMOTE_URL,
        },
        sourceRemote: 'origin',
        sourceBranch: 'main',
        sourceCommit: FROZEN_COMMIT,
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        expectedHead: FROZEN_COMMIT,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'guidance-frozen',
      payload: {
        sourceCommit: FROZEN_COMMIT,
        manifestPath: 'guidance-manifest.json',
        aggregateHash: GOLDEN_AGGREGATE_HASH,
        files: [],
      },
    });
    yield* emit(runDirectory, false, {
      type: 'worktree-ready',
      payload: {
        taskBranch: TASK_BRANCH,
        workspace: WORKSPACE,
        headCommit: FROZEN_COMMIT,
        baseCommit: FROZEN_COMMIT,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
    });
    yield* emit(runDirectory, false, {
      type: 'plan-accepted',
      payload: {
        outcome: 'plan_ready',
        criteria: [{ id: 'AC-001', text: 'The change satisfies the request.' }],
        runtimeValidationRequired,
        execution: {
          mode: 'sequential',
          objectives: [
            {
              id: 'OBJ-001',
              title: 'Implement the accepted plan',
              affectedPaths: ['.'],
              criterionIds: ['AC-001'],
            },
          ],
        },
      },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: { route: 'plan-accepted', from: 'planning', to: 'coding', checkpoint: null },
    });
    yield* emit(runDirectory, false, {
      type: 'implementation-accepted',
      payload: {
        taskBranch: TASK_BRANCH,
        baseCommit: FROZEN_COMMIT,
        commit: RESULT_COMMIT,
        changedFiles: ['src/implementation.ts'],
        noChangeCandidate: false,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'implementation-ready',
        from: 'coding',
        to: 'verifying',
        checkpoint: null,
      },
    });
  });
}

function seedHumanDecision(runDirectory: string) {
  return Effect.gen(function* () {
    yield* emit(runDirectory, false, {
      type: 'role-session-created',
      payload: {
        role: 'reviewer',
        attempt: 1,
        generation: 1,
        sessionId: 'reviewer-session',
        ownershipToken: 'reviewer-owner',
        sequence: 0,
        runtimeIdentity: {
          adapterVersion: 'test',
          provider: 'test',
          model: 'test',
          toolProfile: 'test',
        },
        workingDirectory: null,
      },
    });
    yield* emit(runDirectory, false, {
      type: 'role-session-observed',
      payload: {
        sessionId: 'reviewer-session',
        generation: 1,
        status: 'settled' as const,
        sequence: 1,
        eventCount: 1,
        narrative: 'A person must choose a bound.',
        control: {
          schemaVersion: 1,
          outcome: 'human_decision_required',
          decision: {
            question: 'Should the stricter bound remain in place?',
            options: [
              { label: 'Keep the stricter bound', action: 'accept' },
              { label: 'Relax the bound', action: 'correct' },
            ],
          },
        },
      },
    });
  });
}

function seedReviewing(runDirectory: string) {
  return Effect.gen(function* () {
    yield* seedProvenance(runDirectory);
    yield* emit(runDirectory, false, {
      type: 'verification-completed',
      payload: verificationReport(),
    });
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'checks-passed-reviewing',
        from: 'verifying',
        to: 'reviewing',
        checkpoint: null,
      },
    });
    yield* seedHumanDecision(runDirectory);
  });
}

function seedPublishing(runDirectory: string) {
  return Effect.gen(function* () {
    yield* seedReviewing(runDirectory);
    yield* emit(runDirectory, false, {
      type: 'workflow-transition',
      payload: {
        route: 'human-decision-required',
        from: 'reviewing',
        to: 'publishing',
        checkpoint: null,
      },
    });
  });
}

const CLEAN_IMPLEMENTATION: ImplementationObservation = {
  workspaceExists: true,
  currentBranch: TASK_BRANCH,
  headCommit: RESULT_COMMIT,
  clean: true,
  baseIsAncestor: true,
  changedFiles: ['src/implementation.ts'],
};

function runGitHarness(): EffectLayer.Layer<RunGit> {
  const unused = (name: string) => Effect.die(new Error(`unexpected RunGit.${name}`));
  return Layer.succeed(
    RunGit,
    RunGit.of({
      inspectRepository: () =>
        Effect.succeed({
          repositoryRoot: '/target',
          gitDirectory: '/target/.git',
          remoteUrl: REMOTE_URL,
        }),
      fetchSource: () => Effect.succeed({ commit: REMOTE_SOURCE_COMMIT }),
      commitExists: () => Effect.succeed(true),
      readBranch: () => Effect.succeed({ exists: true, commit: RESULT_COMMIT }),
      createBranch: () => unused('createBranch'),
      readWorktree: () => unused('readWorktree'),
      createWorktree: () => unused('createWorktree'),
      observeImplementation: () => Effect.succeed(CLEAN_IMPLEMENTATION),
    }),
  );
}

/**
 * Wraps the live Git adapter and reports the publication remote as a GitHub
 * repository, so the run provisioning stays real while decision publication
 * can confirm the repository identity.
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

/**
 * Reports the publication remote as a GitHub repository and answers the
 * ancestry probe safely; every other readiness Git command is inert.
 */
function readinessGitHarness(): EffectLayer.Layer<ReadinessGit> {
  return Layer.succeed(
    ReadinessGit,
    ReadinessGit.of({
      run: (args: ReadonlyArray<string>): Effect.Effect<GitCommandResult, never> =>
        Effect.succeed({
          stdout: args[0] === 'remote' ? `${PUBLICATION_REMOTE_URL}\n` : '',
          exitCode: 0,
        }),
    }),
  );
}

function publicationReadinessGit(): EffectLayer.Layer<ReadinessGit> {
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

interface GitHubHarness {
  readonly layer: EffectLayer.Layer<GitHubPublication>;
  readonly pushes: number;
  readonly creates: number;
}

function githubPublishingHarness(mode: 'success' | 'ambiguous'): GitHubHarness {
  const calls = { pushes: 0, creates: 0 };
  const draftPrUrl = `https://github.com/${REPOSITORY}/pull/12`;
  const layer = Layer.succeed(
    GitHubPublication,
    GitHubPublication.of({
      lookupRepositoryIdentity: (options) => Effect.succeed({ repository: options.repository }),
      lookupExactPullRequest: (options) => {
        if (mode === 'ambiguous') {
          return Effect.succeed({ kind: 'ambiguous' as const, detail: 'two candidate draft PRs' });
        }
        if (calls.creates === 0) {
          return Effect.succeed({ kind: 'absent' as const });
        }
        return Effect.succeed({
          kind: 'exact' as const,
          pullRequest: {
            number: 12,
            url: draftPrUrl,
            draft: true,
            headBranch: options.headBranch,
            headCommit: options.headCommit,
            baseBranch: options.baseBranch,
          },
        });
      },
      createDraftPullRequest: (options) => {
        calls.creates += 1;
        return Effect.succeed({
          number: 12,
          url: draftPrUrl,
          draft: true,
          headBranch: options.headBranch,
          headCommit: RESULT_COMMIT,
          baseBranch: options.baseBranch,
        });
      },
      openResultPullRequest: () => Effect.die(new Error('no result PR is expected')),
      refreshOwnedDraftPullRequestBody: () => Effect.die(new Error('no draft refresh is expected')),
      enablePullRequestAutoMerge: () => Effect.die(new Error('no auto-merge is expected')),
      pushTaskBranch: () => {
        calls.pushes += 1;
        return Effect.void;
      },
      pushSourceBranch: () => Effect.die(new Error('no source push is expected')),
      listIssueCommentsAfter: () => Effect.succeed({ comments: [], truncated: false }),
      collaboratorPermission: () => Effect.succeed({ permission: 'maintain' }),
    }),
  );
  return {
    layer,
    get pushes() {
      return calls.pushes;
    },
    get creates() {
      return calls.creates;
    },
  };
}

function stubRoleHostLauncher(): EffectLayer.Layer<RoleHostLauncher> {
  const host = Layer.succeed(
    RoleHost,
    RoleHost.of({
      capabilities: () => Effect.succeed(CAPABLE_ROLE_HOST_CAPABILITIES),
      create: () => Effect.die(new Error('publishing routing must not create a role session')),
      submit: () => Effect.die(new Error('publishing routing must not submit a role turn')),
      observe: () => Effect.die(new Error('publishing routing must not observe a role turn')),
      stop: () => Effect.die(new Error('publishing routing must not stop a role session')),
    }),
  );
  return Layer.succeed(RoleHostLauncher, RoleHostLauncher.of({ launch: () => host }));
}

const platformLayers = Layer.mergeAll(
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
);

function configurationFor(options: {
  readonly runtimeProfile: boolean;
  readonly publication: boolean;
}): Effect.Effect<ProjectConfiguration, unknown> {
  return decodeProjectConfiguration(
    {
      ...goldenConfigurationDocument('/target', options.runtimeProfile),
      decisionPublication: options.publication
        ? { remote: 'origin', draft: true, maintainersCanModify: false }
        : null,
    },
    '/target',
  );
}

function readHistory(runDirectory: string) {
  return readVerifiedRunHistory({
    runDirectory,
    runId: RUN_ID,
    createIfMissing: false,
  }).pipe(Effect.provide(RunHistoryLive));
}

function temporaryRunDirectory(label: string) {
  const base = mkdtempSync(join(tmpdir(), `foundry-pub-routing-${label}-`));
  const runDirectory = join(base, '.agent', 'runs', RUN_ID);
  mkdirSync(runDirectory, { recursive: true });
  return { base, runDirectory, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function routesOf(events: ReadonlyArray<RunEvent>): ReadonlyArray<string> {
  return events
    .map((event) => (event.type === 'workflow-transition' ? event.payload.route : ''))
    .filter((route) => route.length > 0);
}

describe('advanceRun routes a publishing run through the publication transaction', () => {
  it.effect('publishes the draft PR and continues to human_decision_required in one run', () => {
    const github = githubPublishingHarness('success');
    return Effect.gen(function* () {
      const fixture = temporaryRunDirectory('publish');
      try {
        const configuration = yield* configurationFor({ runtimeProfile: false, publication: true });
        yield* seedPublishing(fixture.runDirectory);
        const summary = yield* advanceRun({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          configDirectory: fixture.base,
          configuration,
          allowResume: false,
        });
        expect(summary.workflowState).toBe('human_decision_required');
        expect(github.creates).toBe(1);
        expect(github.pushes).toBe(1);

        const history = yield* readHistory(fixture.runDirectory);
        expect(history.derived.state).toBe('human_decision_required');
        expect(routesOf(history.events)).toContain('draft-pr-reconciled');
        expect(
          history.events.some(
            (event) =>
              event.type === 'publication-checkpoint' &&
              event.payload.stage === 'url-recorded' &&
              event.payload.draftPrUrl !== null,
          ),
        ).toBe(true);
      } finally {
        fixture.cleanup();
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          platformLayers,
          readinessGitHarness(),
          runGitHarness(),
          github.layer,
          stubRoleHostLauncher(),
        ),
      ),
    );
  });

  it.effect('reports publish_failed when the publication cannot be reconciled safely', () =>
    Effect.gen(function* () {
      const fixture = temporaryRunDirectory('publish-failed');
      try {
        const configuration = yield* configurationFor({ runtimeProfile: false, publication: true });
        yield* seedPublishing(fixture.runDirectory);
        const summary = yield* advanceRun({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          configDirectory: fixture.base,
          configuration,
          allowResume: false,
        });
        expect(summary.workflowState).toBe('publish_failed');
        const history = yield* readHistory(fixture.runDirectory);
        expect(history.derived.state).toBe('publish_failed');
      } finally {
        fixture.cleanup();
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          platformLayers,
          readinessGitHarness(),
          runGitHarness(),
          githubPublishingHarness('ambiguous').layer,
          stubRoleHostLauncher(),
        ),
      ),
    ),
  );

  it.effect('a resume re-enters publishing and reconciles the waiting draft', () => {
    const github = githubPublishingHarness('success');
    return Effect.gen(function* () {
      const fixture = temporaryRunDirectory('resume-publishing');
      try {
        const configuration = yield* configurationFor({ runtimeProfile: false, publication: true });
        yield* seedPublishing(fixture.runDirectory);
        const summary = yield* advanceRun({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          configDirectory: fixture.base,
          configuration,
          allowResume: true,
        });
        expect(summary.workflowState).toBe('human_decision_required');
        expect(summary.decision?.waiting).toBe(true);
        expect(github.creates).toBe(1);

        const history = yield* readHistory(fixture.runDirectory);
        expect(routesOf(history.events)).toContain('draft-pr-reconciled');
      } finally {
        fixture.cleanup();
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          platformLayers,
          readinessGitHarness(),
          runGitHarness(),
          github.layer,
          stubRoleHostLauncher(),
        ),
      ),
    );
  });

  it.effect('settles blocked when runtime validation is required without a runtime profile', () =>
    Effect.gen(function* () {
      const fixture = temporaryRunDirectory('runtime-missing');
      try {
        const configuration = yield* configurationFor({
          runtimeProfile: false,
          publication: false,
        });
        yield* seedProvenance(fixture.runDirectory, true);
        yield* emit(fixture.runDirectory, false, {
          type: 'verification-completed',
          payload: verificationReport(),
        });
        const summary = yield* advanceRun({
          runDirectory: fixture.runDirectory,
          runId: RUN_ID,
          configDirectory: fixture.base,
          configuration,
          allowResume: false,
        });
        expect(summary.workflowState).not.toBe('completed');
        expect(summary.workflowState).toBe('blocked');
        const history = yield* readHistory(fixture.runDirectory);
        expect(history.events.some((event) => event.type === 'runtime-lifecycle')).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          platformLayers,
          readinessGitHarness(),
          runGitHarness(),
          githubPublishingHarness('success').layer,
          stubRoleHostLauncher(),
        ),
      ),
    ),
  );
});

describe('a publish_failed run is reported with the exit-1 publish_failed kind', () => {
  it.live('maps an unreconcilable decision publication to the publish_failed failure kind', () => {
    const base = mkdtempSync(join(tmpdir(), 'foundry-pub-routing-cli-'));
    const target = join(base, 'target');
    const remote = join(base, 'remote.git');
    execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
    execFileSync('git', ['init', '-b', 'main', target], { encoding: 'utf8' });
    execFileSync('git', ['-C', target, 'config', 'user.email', 'pub@example.com']);
    execFileSync('git', ['-C', target, 'config', 'user.name', 'Foundry Publishing']);
    writeFileSync(join(target, '.gitignore'), '.agent\n');
    writeFileSync(join(target, 'README.md'), '# target\n');
    execFileSync('git', ['-C', target, 'add', '.gitignore', 'README.md']);
    execFileSync('git', ['-C', target, 'commit', '-m', 'initial']);
    execFileSync('git', ['-C', target, 'remote', 'add', 'origin', remote]);
    execFileSync('git', ['-C', target, 'push', '-u', 'origin', 'main']);
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

    const script: StandInRoleHostScript = {
      architect: {
        narrative: 'The plan is ready.',
        control: {
          schemaVersion: 1,
          outcome: 'plan_ready',
          acceptanceCriteria: ['the app is observable'],
          runtimeValidation: 'not_required',
          execution: 'sequential',
        },
      },
      coder: {
        narrative: 'Implemented the change.',
        control: { schemaVersion: 1, outcome: 'implemented' },
        act: (context) =>
          Effect.sync(() => {
            const name = 'publishing-routing-change.txt';
            writeFileSync(join(context.workingDirectory, name), 'change\n');
            execFileSync('git', ['-C', context.workingDirectory, 'add', name]);
            execFileSync('git', ['-C', context.workingDirectory, 'commit', '-m', 'change']);
          }),
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
    };

    return Effect.gen(function* () {
      try {
        const result = yield* runCli([
          'run',
          '--config',
          configPath,
          '--request',
          requestPath,
          '--task-id',
          'TASK-PUB-CLI',
          '--run-id',
          'RUN-PUB-CLI',
          '--json',
        ]).pipe(
          Effect.provide(
            Layer.mergeAll(
              platformLayers,
              publicationReadinessGit(),
              publicationRunGit(),
              githubPublishingHarness('ambiguous').layer,
              standInRoleHost(script),
            ),
          ),
        );

        expect(result.exitCode).toBe(1);
        const envelope = Schema.decodeUnknownSync(ReportEnvelopeJson)(result.stdout);
        expect(envelope.ok).toBe(false);
        if (envelope.ok) {
          throw new Error(`Expected a failure envelope: ${result.stdout}`);
        }
        expect(envelope.error.kind).toBe('publish_failed');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
});
