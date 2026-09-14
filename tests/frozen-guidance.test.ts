import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GUIDANCE_PROMPT_HEADING,
  GUIDANCE_PROMPT_PRIORITY_STATEMENT,
  GuidanceGit,
  GuidanceSnapshotInvalid,
  GuidanceSnapshotRejected,
  bootstrapRoleGuidance,
  selectGuidanceFilesForSubtree,
} from '../src/application/guidance/index.js';
import { ReadinessHost } from '../src/application/readiness/index.js';
import { readRunWorkflowState, recordRunIdentity } from '../src/application/run-identity/index.js';
import {
  RUN_HISTORY_FILENAME,
  RunEventSchema,
  sealRunEvent,
  verifyRunHistoryEvents,
} from '../src/domain/run-history.js';
import {
  GuidanceSnapshotManifestSchema,
  computeGuidanceAggregateHash,
  computeGuidanceContentHash,
} from '../src/domain/guidance.js';
import { HARDCODED_ARTIFACT_BOUNDS } from '../src/domain/project-configuration.js';
import { ReadinessFilesLive } from '../src/platform/readiness.js';
import { RepositoryLeaseLive } from '../src/platform/repository-lease.js';
import { RunGitLive } from '../src/platform/git-provisioning.js';
import { GuidanceGitLive, GuidanceSnapshotStoreLive } from '../src/platform/guidance.js';
import { RunHistoryLive } from '../src/platform/run-history.js';
import { RunIdentityLive } from '../src/platform/run-identity.js';
import { capableRoleHostLauncher } from './fixtures/role-host/role-host-launcher.js';

import type { RunEvent, RunEventDraft, RunEventEnvelope } from '../src/domain/run-history.js';
import type { GuidanceSnapshotManifest } from '../src/domain/guidance.js';
import type { GuidanceFrozenPayload } from '../src/domain/run-history.js';
import type { GuidanceSnapshotStore } from '../src/application/guidance/index.js';
import type { RunGit } from '../src/application/git-provisioning/index.js';
import type { ReadinessFiles } from '../src/application/readiness/index.js';
import type {
  RepositoryHostIdentity,
  RepositoryLeaseStore,
} from '../src/application/repository-lease/index.js';
import type { RunHistoryStorage } from '../src/application/run-history/index.js';
import type { RunIdentityStore } from '../src/application/run-identity/index.js';
import type { RoleHostLauncher } from '../src/application/role-conversations/index.js';

type ApplicationLayer =
  | ReadinessHost
  | ReadinessFiles
  | RunIdentityStore
  | RunHistoryStorage
  | RepositoryLeaseStore
  | RepositoryHostIdentity
  | RoleHostLauncher
  | RunGit
  | GuidanceGit
  | GuidanceSnapshotStore;

const TASK_ID = 'frozen-guidance';

const TASK_BRANCH = `foundry/${TASK_ID}`;

const ROOT_GUIDANCE = '# Root guidance\n\nRoot rules apply everywhere.\n';

const SRC_GUIDANCE = '# Source guidance\n\nSource rules apply to src.\n';

const DOCS_GUIDANCE = '# Docs guidance\n\nDocs rules apply to docs.\n';

const EXTRA_GUIDANCE = '# Extra guidance\n\nListed explicitly by configuration.\n';

const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

function git(dir: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', [...args], { cwd: dir, encoding: 'utf8' });
}

function gitIn(dir: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

function gitBytes(dir: string, args: ReadonlyArray<string>): Buffer {
  return execFileSync('git', [...args], { cwd: dir });
}

function goldenDocument(targetRepository: string, guidancePaths: ReadonlyArray<string>) {
  // 055: artifact bounds are hardcoded; the document carries no `artifacts`
  // block and oversized-guidance tests generate content past the fixed bound.
  return {
    schemaVersion: 1,
    targetRepository,
    sourceRemote: 'origin',
    sourceBranch: 'main',
    taskBranchPolicy: 'foundry/<task-id>',
    roleHarness: {
      protocol: 'foundry-role-host-v1',
      command: ['foundry-role-host'],
      environmentAllowlist: [],
    },
    roles: {
      architect: { harness: 'codex', model: 'gpt-5-codex' },
      coder: { harness: 'codex', model: 'gpt-5-codex' },
      lead_coder: { harness: 'opencode', model: 'openai/gpt-5' },
      tester: { harness: 'opencode', model: 'openai/gpt-5' },
      reviewer: { harness: 'codex', model: 'gpt-5-codex' },
    },
    timeouts: {
      roleMs: 1800000,
      settleMs: 30000,
      pollMs: 100,
      commandMs: 900000,
      runtimeReadinessMs: 120000,
      cleanupMs: 30000,
      leaseMs: 60000,
    },
    retryBudgets: { architect: 1, coder: 2, tester: 1, reviewer: 1 },
    operationalRetryBudgets: { git: 2, runtime: 1, publication: 2, cleanup: 1 },
    limits: { maxParallelCoders: 4, maxCorrectionRounds: 2, maxControlRepairsPerAttempt: 1 },
    projectProfile: {
      guidancePaths,
      commands: {
        bootstrap: ['npm', 'ci'],
        formatCheck: ['npm', 'run', 'format:check'],
        lint: ['npm', 'run', 'lint'],
        typecheck: ['npm', 'run', 'typecheck'],
        test: ['npm', 'test'],
        build: ['npm', 'run', 'build'],
      },
    },
    runtimeProfile: null,
    decisionPublication: null,
  };
}

interface GuidanceFixture {
  readonly base: string;
  readonly target: string;
  readonly remote: string;
  readonly home: string;
  readonly configPath: string;
  readonly requestPath: string;
  readonly runDirectory: (runId: string) => string;
  readonly cleanup: () => void;
}

interface GuidanceFixtureOptions {
  readonly label: string;
  readonly guidancePaths?: (paths: {
    readonly target: string;
    readonly home: string;
  }) => ReadonlyArray<string>;
  readonly beforeCommit?: (target: string) => void;
  readonly afterCommit?: (target: string) => void;
}

function setupGuidanceFixture(options: GuidanceFixtureOptions): GuidanceFixture {
  const base = mkdtempSync(join(tmpdir(), `foundry-guidance-${options.label}-`));
  const target = join(base, 'target');
  const remote = join(base, 'remote.git');
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['init', '--bare', remote], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'main', target], { encoding: 'utf8' });
  git(target, ['config', 'user.email', 'guidance@example.com']);
  git(target, ['config', 'user.name', 'Foundry Guidance']);
  writeFileSync(join(target, '.gitignore'), '.agent\n');
  writeFileSync(join(target, 'README.md'), '# target\n');
  mkdirSync(join(target, 'src'), { recursive: true });
  mkdirSync(join(target, 'docs'), { recursive: true });
  mkdirSync(join(target, '.agent'), { recursive: true });
  writeFileSync(join(target, 'AGENTS.md'), ROOT_GUIDANCE);
  writeFileSync(join(target, 'src', 'AGENTS.md'), SRC_GUIDANCE);
  writeFileSync(join(target, 'docs', 'AGENTS.md'), DOCS_GUIDANCE);
  writeFileSync(join(target, 'docs', 'guide.md'), EXTRA_GUIDANCE);
  writeFileSync(
    join(target, '.agent', 'AGENTS.md'),
    '# run-only guidance that must not be snapshotted\n',
  );
  options.beforeCommit?.(target);
  git(target, ['add', '-A']);
  git(target, ['add', '-f', '.agent/AGENTS.md']);
  git(target, ['commit', '-m', 'initial']);
  options.afterCommit?.(target);
  git(target, ['remote', 'add', 'origin', remote]);
  git(target, ['push', '-u', 'origin', 'main']);
  const guidancePaths =
    options.guidancePaths === undefined ? [] : options.guidancePaths({ target, home });
  const configPath = join(home, 'foundry.config.json');
  writeFileSync(configPath, JSON.stringify(goldenDocument(target, guidancePaths)));
  const requestPath = join(home, 'request.md');
  writeFileSync(requestPath, `# Outcome\n\n${options.label}\n`);
  return {
    base,
    target,
    remote,
    home,
    configPath,
    requestPath,
    runDirectory: (runId: string) => join(target, '.agent', 'runs', runId),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

const integrationHost = Layer.succeed(
  ReadinessHost,
  ReadinessHost.of({
    platform: Effect.succeed('linux'),
    nodeVersion: Effect.succeed('v24.14.0'),
    npmVersion: Effect.succeed('11.9.0'),
    gitVersionOutput: Effect.succeed('git version 2.53.0\n'),
  }),
);

const AppLive = Layer.mergeAll(
  integrationHost,
  ReadinessFilesLive,
  RunIdentityLive,
  RunHistoryLive,
  RepositoryLeaseLive,
  RunGitLive,
  GuidanceGitLive,
  GuidanceSnapshotStoreLive,
  capableRoleHostLauncher(),
);

function failingGuidanceGit(): Layer.Layer<GuidanceGit> {
  return Layer.effect(
    GuidanceGit,
    Effect.gen(function* () {
      const live = yield* GuidanceGit;
      return GuidanceGit.of({
        ...live,
        listCommitPaths: (readOptions) =>
          Effect.fail(
            new GuidanceSnapshotRejected({
              message: `Injected guidance Git read failure for run "${readOptions.runId}".`,
              problem: 'guidance-git-read-failed',
              runId: readOptions.runId,
            }),
          ),
      });
    }),
  ).pipe(Layer.provide(GuidanceGitLive));
}

function record(
  fixture: GuidanceFixture,
  runId: string,
  layer: Layer.Layer<ApplicationLayer> = AppLive,
) {
  return recordRunIdentity({
    configArg: fixture.configPath,
    cwd: fixture.target,
    requestArg: fixture.requestPath,
    taskId: TASK_ID,
    runId,
  }).pipe(Effect.provide(layer));
}

const RunEventJson = Schema.fromJsonString(RunEventSchema);

function readEvents(runDirectory: string): ReadonlyArray<RunEvent> {
  const text = readFileSync(join(runDirectory, RUN_HISTORY_FILENAME), 'utf8');
  const lines = text.split('\n');
  lines.pop();
  return lines.map((line) =>
    Schema.decodeUnknownSync(RunEventJson, { onExcessProperty: 'error' })(line),
  );
}

function readManifest(runDirectory: string): GuidanceSnapshotManifest {
  return Schema.decodeUnknownSync(Schema.fromJsonString(GuidanceSnapshotManifestSchema), {
    onExcessProperty: 'error',
  })(readFileSync(join(runDirectory, 'guidance-manifest.json'), 'utf8'));
}

function readGuidanceCheckpoint(runDirectory: string): GuidanceFrozenPayload {
  const event = readEvents(runDirectory).find((candidate) => candidate.type === 'guidance-frozen');
  if (event === undefined || event.type !== 'guidance-frozen') {
    throw new Error('Expected a guidance-frozen event.');
  }
  return event.payload;
}

function branchCommit(target: string, branch: string): string | null {
  try {
    const output = execFileSync(
      'git',
      ['-C', target, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
      { encoding: 'utf8' },
    ).trim();
    return output.length === 0 ? null : output;
  } catch {
    return null;
  }
}

function workspacePath(fixture: GuidanceFixture): string {
  return join(fixture.target, '.agent', 'worktrees', TASK_ID);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function chainedEvents(
  runId: string,
  drafts: ReadonlyArray<RunEventDraft>,
): ReadonlyArray<RunEvent> {
  const events: Array<RunEvent> = [];
  for (const [index, draft] of drafts.entries()) {
    const previous = events[index - 1];
    const envelope: RunEventEnvelope = {
      schemaVersion: 1,
      runId,
      revision: index + 1,
      eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      occurredAt: '2026-09-13T00:00:00.000Z',
      previousEventHash: previous?.eventHash ?? null,
    };
    events.push(sealRunEvent(envelope, draft));
  }
  return events;
}

const RUN_CREATED_DRAFT: RunEventDraft = {
  type: 'run-created',
  payload: { taskId: TASK_ID },
};

const SOURCE_FROZEN_DRAFT: RunEventDraft = {
  type: 'source-frozen',
  payload: {
    repository: {
      repositoryRoot: '/target',
      gitDirectory: '/target/.git',
      remoteUrl: 'https://example.invalid/target.git',
    },
    sourceRemote: 'origin',
    sourceBranch: 'main',
    sourceCommit: SOURCE_COMMIT,
    taskBranch: TASK_BRANCH,
    workspace: `/target/.agent/worktrees/${TASK_ID}`,
    expectedHead: SOURCE_COMMIT,
  },
};

const GUIDANCE_FROZEN_DRAFT: RunEventDraft = {
  type: 'guidance-frozen',
  payload: {
    sourceCommit: SOURCE_COMMIT,
    manifestPath: 'guidance-manifest.json',
    aggregateHash: computeGuidanceAggregateHash(SOURCE_COMMIT, []),
    files: [],
  },
};

const WORKTREE_READY_DRAFT: RunEventDraft = {
  type: 'worktree-ready',
  payload: {
    taskBranch: TASK_BRANCH,
    workspace: `/target/.agent/worktrees/${TASK_ID}`,
    headCommit: SOURCE_COMMIT,
    baseCommit: SOURCE_COMMIT,
  },
};

const TRANSITION_CREATED_DRAFT: RunEventDraft = {
  type: 'workflow-transition',
  payload: { route: 'run-created', from: null, to: 'planning', checkpoint: null },
};

describe('guidance-frozen history semantics', () => {
  it('accepts one guidance checkpoint between the source freeze and planning', () => {
    const events = chainedEvents('RUN-1', [
      RUN_CREATED_DRAFT,
      SOURCE_FROZEN_DRAFT,
      GUIDANCE_FROZEN_DRAFT,
      WORKTREE_READY_DRAFT,
      TRANSITION_CREATED_DRAFT,
    ]);
    const verification = verifyRunHistoryEvents(events, 'RUN-1');
    expect(verification.ok).toBe(true);
    if (verification.ok) {
      expect(verification.derived.guidanceFrozen).toMatchObject({
        sourceCommit: SOURCE_COMMIT,
        manifestPath: 'guidance-manifest.json',
      });
    }
  });

  it('rejects guidance before the source freeze, duplicates, and commit mismatches', () => {
    const beforeSource = verifyRunHistoryEvents(
      chainedEvents('RUN-1', [RUN_CREATED_DRAFT, GUIDANCE_FROZEN_DRAFT]),
      'RUN-1',
    );
    expect(beforeSource.ok).toBe(false);
    if (!beforeSource.ok) {
      expect(beforeSource.problem).toContain('before the source freeze');
    }

    const duplicated = verifyRunHistoryEvents(
      chainedEvents('RUN-1', [
        RUN_CREATED_DRAFT,
        SOURCE_FROZEN_DRAFT,
        GUIDANCE_FROZEN_DRAFT,
        GUIDANCE_FROZEN_DRAFT,
      ]),
      'RUN-1',
    );
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.problem).toContain('appears again');
    }

    const mismatched: RunEventDraft = {
      type: 'guidance-frozen',
      payload: {
        ...GUIDANCE_FROZEN_DRAFT.payload,
        sourceCommit: 'ffffffffffffffffffffffffffffffffffffffff',
      },
    };
    const wrongCommit = verifyRunHistoryEvents(
      chainedEvents('RUN-1', [RUN_CREATED_DRAFT, SOURCE_FROZEN_DRAFT, mismatched]),
      'RUN-1',
    );
    expect(wrongCommit.ok).toBe(false);
    if (!wrongCommit.ok) {
      expect(wrongCommit.problem).toContain('different source commit');
    }
  });

  it('rejects planning without a guidance checkpoint', () => {
    const events = chainedEvents('RUN-1', [
      RUN_CREATED_DRAFT,
      SOURCE_FROZEN_DRAFT,
      WORKTREE_READY_DRAFT,
      TRANSITION_CREATED_DRAFT,
    ]);
    const verification = verifyRunHistoryEvents(events, 'RUN-1');
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(verification.problem).toContain('before durable frozen guidance');
    }
  });
});

describe('frozen guidance snapshot', () => {
  it.effect(
    'retains every eligible tracked AGENTS.md plus configured guidance from the commit',
    () =>
      Effect.gen(function* () {
        const fixture = setupGuidanceFixture({
          label: 'snapshot',
          guidancePaths: ({ target }) => [
            join(target, 'docs', 'guide.md'),
            join(target, 'AGENTS.md'),
          ],
        });
        try {
          const frozenCommit = gitIn(fixture.target, ['rev-parse', 'HEAD']).trim();
          writeFileSync(
            join(fixture.target, 'AGENTS.md'),
            '# Live mutation that must be ignored\n',
          );
          writeFileSync(join(fixture.target, 'docs', 'guide.md'), '# Live mutation\n');

          const report = yield* record(fixture, 'RUN-GUIDE-SNAPSHOT');

          const manifest = readManifest(report.runDirectory);
          expect(manifest.runId).toBe('RUN-GUIDE-SNAPSHOT');
          expect(manifest.sourceCommit).toBe(frozenCommit);
          expect(manifest.files.map((file) => file.path)).toEqual([
            'AGENTS.md',
            'docs/AGENTS.md',
            'docs/guide.md',
            'src/AGENTS.md',
          ]);

          const checkpoint = readGuidanceCheckpoint(report.runDirectory);
          expect(checkpoint).toEqual({
            sourceCommit: frozenCommit,
            manifestPath: 'guidance-manifest.json',
            aggregateHash: computeGuidanceAggregateHash(frozenCommit, manifest.files),
            files: manifest.files,
          });
          expect(manifest.aggregateHash).toBe(checkpoint.aggregateHash);

          for (const file of manifest.files) {
            const retained = readFileSync(join(report.runDirectory, file.retainedPath));
            const committed = gitBytes(fixture.target, ['show', `${frozenCommit}:${file.path}`]);
            expect(Buffer.compare(retained, committed)).toBe(0);
            expect(file.byteLength).toBe(committed.byteLength);
            expect(file.contentHash).toBe(createHash('sha256').update(committed).digest('hex'));
          }

          expect(readFileSync(join(report.runDirectory, 'guidance', 'AGENTS.md'), 'utf8')).toBe(
            ROOT_GUIDANCE,
          );
          expect(
            readFileSync(join(report.runDirectory, 'guidance', 'docs', 'AGENTS.md'), 'utf8'),
          ).toBe(DOCS_GUIDANCE);
          expect(existsSync(join(report.runDirectory, 'guidance', '.agent', 'AGENTS.md'))).toBe(
            false,
          );

          const progress = yield* readRunWorkflowState({
            configArg: fixture.configPath,
            cwd: fixture.target,
            runId: 'RUN-GUIDE-SNAPSHOT',
          }).pipe(Effect.provide(AppLive));
          expect(progress.workflowState).toBe('planning');
        } finally {
          fixture.cleanup();
        }
      }),
  );

  it.effect(
    'rejects missing, untracked, escaping, symlinked, oversized, and non-text guidance before work',
    () =>
      Effect.gen(function* () {
        interface RejectionCase {
          readonly label: string;
          readonly problem: string;
          readonly guidancePaths: (paths: {
            readonly target: string;
            readonly home: string;
          }) => ReadonlyArray<string>;
          readonly beforeCommit?: (target: string) => void;
          readonly afterCommit?: (target: string) => void;
        }

        const makeUntracked = (target: string): void => {
          writeFileSync(join(target, 'docs', 'live-only.md'), '# live only\n');
        };

        const cases: ReadonlyArray<RejectionCase> = [
          {
            label: 'missing',
            problem: 'configured-path-missing',
            guidancePaths: ({ target }) => [join(target, 'docs', 'missing.md')],
          },
          {
            label: 'untracked',
            problem: 'configured-path-untracked',
            guidancePaths: ({ target }) => [join(target, 'docs', 'live-only.md')],
            afterCommit: makeUntracked,
          },
          {
            label: 'outside',
            problem: 'configured-path-escapes-target',
            guidancePaths: ({ home }) => [join(home, '..', 'outside.md')],
          },
          {
            label: 'symlink',
            problem: 'guidance-path-not-regular',
            guidancePaths: ({ target }) => [join(target, 'docs', 'link.md')],
            beforeCommit: (target) => {
              symlinkSync('guide.md', join(target, 'docs', 'link.md'));
            },
          },
          {
            label: 'per-file-limit',
            problem: 'guidance-file-too-large',
            guidancePaths: ({ target }) => [join(target, 'docs', 'guide.md')],
            // 055: exceed the fixed maxGuidanceBytes by an exact bounded amount.
            beforeCommit: (target) => {
              writeFileSync(
                join(target, 'docs', 'guide.md'),
                'g'.repeat(HARDCODED_ARTIFACT_BOUNDS.maxGuidanceBytes + 17),
              );
            },
          },
          {
            label: 'aggregate-limit',
            problem: 'guidance-aggregate-too-large',
            guidancePaths: ({ target }) => [
              join(target, 'docs', 'guide.md'),
              join(target, 'docs', 'extra.md'),
            ],
            // 055: each file stays under the fixed maxGuidanceBytes while the
            // aggregate honestly exceeds it.
            beforeCommit: (target) => {
              writeFileSync(join(target, 'docs', 'guide.md'), 'g'.repeat(600_000));
              writeFileSync(join(target, 'docs', 'extra.md'), 'e'.repeat(500_000));
            },
          },
          {
            label: 'invalid-text',
            problem: 'guidance-text-not-utf8',
            guidancePaths: ({ target }) => [join(target, 'docs', 'binary.md')],
            beforeCommit: (target) => {
              writeFileSync(join(target, 'docs', 'binary.md'), Buffer.from([0xff, 0xfe, 0x00]));
            },
          },
        ];

        for (const testCase of cases) {
          const fixture = setupGuidanceFixture({
            label: `reject-${testCase.label}`,
            guidancePaths: testCase.guidancePaths,
            beforeCommit: testCase.beforeCommit,
            afterCommit: testCase.afterCommit,
          });
          try {
            const runId = `RUN-REJECT-${testCase.label.toUpperCase()}`;
            const error = yield* record(fixture, runId).pipe(Effect.flip);
            expect(error, testCase.label).toBeInstanceOf(GuidanceSnapshotRejected);
            if (!(error instanceof GuidanceSnapshotRejected)) {
              throw new Error(`Expected a guidance preflight rejection for ${testCase.label}.`);
            }
            expect(error.problem, testCase.label).toBe(testCase.problem);

            expect(branchCommit(fixture.target, TASK_BRANCH), testCase.label).toBeNull();
            expect(existsSync(workspacePath(fixture)), testCase.label).toBe(false);

            const runDirectory = fixture.runDirectory(runId);
            const events = readEvents(runDirectory);
            expect(
              events.some((event) => event.type === 'worktree-ready'),
              testCase.label,
            ).toBe(false);
            expect(
              events.some((event) => event.type === 'guidance-frozen'),
              testCase.label,
            ).toBe(false);

            const progress = yield* readRunWorkflowState({
              configArg: fixture.configPath,
              cwd: fixture.target,
              runId,
            }).pipe(Effect.provide(AppLive));
            expect(progress.workflowState, testCase.label).toBe('blocked');
          } finally {
            fixture.cleanup();
          }
        }
      }),
  );

  it.effect('applies nested guidance to its subtree from the snapshot, not the live tree', () =>
    Effect.gen(function* () {
      const fixture = setupGuidanceFixture({
        label: 'bootstrap',
        guidancePaths: ({ target }) => [join(target, 'docs', 'guide.md')],
      });
      try {
        const report = yield* record(fixture, 'RUN-GUIDE-BOOTSTRAP');
        const runDirectory = report.runDirectory;
        const checkpoint = readGuidanceCheckpoint(runDirectory);

        rmSync(join(fixture.target, 'AGENTS.md'));
        rmSync(join(fixture.target, 'src', 'AGENTS.md'));
        writeFileSync(join(fixture.target, 'docs', 'guide.md'), '# live changed\n');

        const srcBootstrap = yield* bootstrapRoleGuidance({
          runDirectory,
          runId: 'RUN-GUIDE-BOOTSTRAP',
          role: 'coder',
          workingSubtree: 'src',
        }).pipe(Effect.provide(AppLive));

        expect(srcBootstrap.role).toBe('coder');
        expect(srcBootstrap.workingSubtree).toBe('src');
        expect(srcBootstrap.provenance.selectedFiles.map((file) => file.path)).toEqual([
          'AGENTS.md',
          'src/AGENTS.md',
          'docs/guide.md',
        ]);
        expect(srcBootstrap.promptSection).toContain(GUIDANCE_PROMPT_HEADING);
        expect(srcBootstrap.promptSection).toContain(GUIDANCE_PROMPT_PRIORITY_STATEMENT);
        expect(srcBootstrap.promptSection).toContain('Do not reread live guidance files');
        expect(srcBootstrap.promptSection).toContain('Root rules apply everywhere.');
        expect(srcBootstrap.promptSection).toContain('Source rules apply to src.');
        expect(srcBootstrap.promptSection).toContain('Listed explicitly by configuration.');
        expect(srcBootstrap.promptSection).not.toContain('Docs rules apply to docs.');
        expect(srcBootstrap.promptSection).not.toContain('# live changed');

        expect(srcBootstrap.provenance).toMatchObject({
          role: 'coder',
          snapshotPath: join(runDirectory, 'guidance-manifest.json'),
          snapshotHash: checkpoint.aggregateHash,
          verificationStatus: 'verified',
        });
        expect(srcBootstrap.provenance.promptHash).toBe(sha256Hex(srcBootstrap.promptSection));

        const repeat = yield* bootstrapRoleGuidance({
          runDirectory,
          runId: 'RUN-GUIDE-BOOTSTRAP',
          role: 'coder',
          workingSubtree: 'src',
        }).pipe(Effect.provide(AppLive));
        expect(repeat.promptSection).toBe(srcBootstrap.promptSection);
        expect(repeat.provenance.promptHash).toBe(srcBootstrap.provenance.promptHash);

        const docsBootstrap = yield* bootstrapRoleGuidance({
          runDirectory,
          runId: 'RUN-GUIDE-BOOTSTRAP',
          role: 'architect',
          workingSubtree: 'docs',
        }).pipe(Effect.provide(AppLive));
        expect(docsBootstrap.provenance.selectedFiles.map((file) => file.path)).toEqual([
          'AGENTS.md',
          'docs/AGENTS.md',
          'docs/guide.md',
        ]);
        expect(docsBootstrap.promptSection).toContain('Docs rules apply to docs.');
        expect(docsBootstrap.promptSection).not.toContain('Source rules apply to src.');

        const rootBootstrap = yield* bootstrapRoleGuidance({
          runDirectory,
          runId: 'RUN-GUIDE-BOOTSTRAP',
          role: 'reviewer',
        }).pipe(Effect.provide(AppLive));
        expect(rootBootstrap.workingSubtree).toBe('');
        expect(rootBootstrap.provenance.selectedFiles.map((file) => file.path)).toEqual([
          'AGENTS.md',
          'docs/AGENTS.md',
          'src/AGENTS.md',
          'docs/guide.md',
        ]);
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('verifies retained guidance on recovery instead of rereading live files', () =>
    Effect.gen(function* () {
      const fixture = setupGuidanceFixture({ label: 'recovery' });
      try {
        const first = yield* record(fixture, 'RUN-GUIDE-RECOVERY');
        const originalManifest = readFileSync(
          join(first.runDirectory, 'guidance-manifest.json'),
          'utf8',
        );
        const originalRoot = readFileSync(
          join(first.runDirectory, 'guidance', 'AGENTS.md'),
          'utf8',
        );
        const firstPrompt = yield* bootstrapRoleGuidance({
          runDirectory: first.runDirectory,
          runId: 'RUN-GUIDE-RECOVERY',
          role: 'coder',
        }).pipe(Effect.provide(AppLive));

        writeFileSync(join(fixture.target, 'AGENTS.md'), '# live replacement\n');
        writeFileSync(join(fixture.target, 'src', 'AGENTS.md'), '# live src replacement\n');

        const resumed = yield* record(fixture, 'RUN-GUIDE-RECOVERY');
        expect(resumed.provenance.sourceCommit).toBe(first.provenance.sourceCommit);
        expect(readFileSync(join(resumed.runDirectory, 'guidance-manifest.json'), 'utf8')).toBe(
          originalManifest,
        );
        expect(readFileSync(join(resumed.runDirectory, 'guidance', 'AGENTS.md'), 'utf8')).toBe(
          originalRoot,
        );

        const resumedPrompt = yield* bootstrapRoleGuidance({
          runDirectory: resumed.runDirectory,
          runId: 'RUN-GUIDE-RECOVERY',
          role: 'coder',
        }).pipe(Effect.provide(AppLive));
        expect(resumedPrompt.promptSection).toBe(firstPrompt.promptSection);

        writeFileSync(
          join(resumed.runDirectory, 'guidance', 'AGENTS.md'),
          '# tampered retained guidance\n',
        );
        const tampered = yield* record(fixture, 'RUN-GUIDE-RECOVERY').pipe(Effect.flip);
        expect(tampered).toBeInstanceOf(GuidanceSnapshotInvalid);
        if (!(tampered instanceof GuidanceSnapshotInvalid)) {
          throw new Error('Expected a guidance integrity error.');
        }
        expect(tampered.problem).toContain('retained-file');

        const tamperedBootstrap = yield* bootstrapRoleGuidance({
          runDirectory: resumed.runDirectory,
          runId: 'RUN-GUIDE-RECOVERY',
          role: 'coder',
        }).pipe(Effect.provide(AppLive), Effect.flip);
        expect(tamperedBootstrap).toBeInstanceOf(GuidanceSnapshotInvalid);

        writeFileSync(join(resumed.runDirectory, 'guidance', 'AGENTS.md'), originalRoot);
        rmSync(join(resumed.runDirectory, 'guidance', 'src', 'AGENTS.md'));
        const missingFile = yield* record(fixture, 'RUN-GUIDE-RECOVERY').pipe(Effect.flip);
        expect(missingFile).toBeInstanceOf(GuidanceSnapshotInvalid);
        if (!(missingFile instanceof GuidanceSnapshotInvalid)) {
          throw new Error('Expected a guidance integrity error.');
        }
        expect(missingFile.problem).toBe('guidance-retained-file-missing');

        rmSync(join(resumed.runDirectory, 'guidance-manifest.json'));
        const missingManifest = yield* record(fixture, 'RUN-GUIDE-RECOVERY').pipe(Effect.flip);
        expect(missingManifest).toBeInstanceOf(GuidanceSnapshotInvalid);
        if (!(missingManifest instanceof GuidanceSnapshotInvalid)) {
          throw new Error('Expected a guidance integrity error.');
        }
        expect(missingManifest.problem).toBe('guidance-manifest-missing');
      } finally {
        fixture.cleanup();
      }
    }),
  );

  it.effect('finishes a source-frozen prefix from the recorded commit objects', () =>
    Effect.gen(function* () {
      const fixture = setupGuidanceFixture({ label: 'prefix' });
      try {
        const frozenCommit = gitIn(fixture.target, ['rev-parse', 'HEAD']).trim();
        const partialLayer = Layer.mergeAll(
          integrationHost,
          ReadinessFilesLive,
          RunIdentityLive,
          RunHistoryLive,
          RepositoryLeaseLive,
          RunGitLive,
          GuidanceSnapshotStoreLive,
          failingGuidanceGit(),
          capableRoleHostLauncher(),
        );

        const failed = yield* record(fixture, 'RUN-GUIDE-PREFIX', partialLayer).pipe(Effect.flip);
        expect(failed).toBeInstanceOf(GuidanceSnapshotRejected);

        const runDirectory = fixture.runDirectory('RUN-GUIDE-PREFIX');
        const prefixEvents = readEvents(runDirectory);
        expect(prefixEvents.map((event) => event.type)).toEqual(['run-created', 'source-frozen']);
        expect(branchCommit(fixture.target, TASK_BRANCH)).toBeNull();
        expect(existsSync(workspacePath(fixture))).toBe(false);

        writeFileSync(join(fixture.target, 'AGENTS.md'), '# live divergence\n');

        const resumed = yield* record(fixture, 'RUN-GUIDE-PREFIX');
        expect(resumed.provenance.sourceCommit).toBe(frozenCommit);
        expect(readFileSync(join(runDirectory, 'guidance', 'AGENTS.md'), 'utf8')).toBe(
          ROOT_GUIDANCE,
        );
        expect(readEvents(runDirectory).map((event) => event.type)).toEqual([
          'run-created',
          'source-frozen',
          'guidance-frozen',
          'worktree-ready',
          'workflow-transition',
        ]);

        const progress = yield* readRunWorkflowState({
          configArg: fixture.configPath,
          cwd: fixture.target,
          runId: 'RUN-GUIDE-PREFIX',
        }).pipe(Effect.provide(AppLive));
        expect(progress.workflowState).toBe('planning');
      } finally {
        fixture.cleanup();
      }
    }),
  );
});

describe('guidance selection and prompt vocabulary', () => {
  it('selects root-to-leaf AGENTS.md files plus explicit guidance deterministically', () => {
    const files = [
      {
        path: 'src/AGENTS.md',
        byteLength: 1,
        contentHash: 'a'.repeat(64),
        retainedPath: 'guidance/src/AGENTS.md',
      },
      {
        path: 'docs/guide.md',
        byteLength: 1,
        contentHash: 'b'.repeat(64),
        retainedPath: 'guidance/docs/guide.md',
      },
      {
        path: 'AGENTS.md',
        byteLength: 1,
        contentHash: 'c'.repeat(64),
        retainedPath: 'guidance/AGENTS.md',
      },
      {
        path: 'docs/AGENTS.md',
        byteLength: 1,
        contentHash: 'd'.repeat(64),
        retainedPath: 'guidance/docs/AGENTS.md',
      },
    ];
    expect(selectGuidanceFilesForSubtree(files, '').map((file) => file.path)).toEqual([
      'AGENTS.md',
      'docs/AGENTS.md',
      'src/AGENTS.md',
      'docs/guide.md',
    ]);
    expect(selectGuidanceFilesForSubtree(files, 'src').map((file) => file.path)).toEqual([
      'AGENTS.md',
      'src/AGENTS.md',
      'docs/guide.md',
    ]);
    expect(selectGuidanceFilesForSubtree(files, 'docs/nested').map((file) => file.path)).toEqual([
      'AGENTS.md',
      'docs/AGENTS.md',
      'docs/guide.md',
    ]);
  });

  it('hashes the retained prompt exactly', () => {
    expect(GUIDANCE_PROMPT_HEADING).toBe('## Frozen project guidance');
    expect(computeGuidanceContentHash(new TextEncoder().encode('guidance'))).toBe(
      sha256Hex('guidance'),
    );
  });
});
