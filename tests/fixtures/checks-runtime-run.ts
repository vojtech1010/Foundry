import { Effect } from 'effect';

import { appendRunEvent } from '../../src/application/run-history/index.js';
import { decodeProjectConfiguration } from '../../src/application/project-configuration.js';

import type { ProjectConfiguration } from '../../src/domain/project-configuration.js';
import type { RunEventDraft } from '../../src/domain/run-history.js';

export const RUN_ID = 'RUN-CHECKS';

export const FROZEN_COMMIT = '0123456789abcdef0123456789abcdef01234567';

export const IMPLEMENTED_COMMIT = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';

export const TASK_BRANCH = 'foundry/RUN-CHECKS';

export const WORKSPACE = '/target/.agent/worktrees/RUN-CHECKS';

export const GOLDEN_AGGREGATE_HASH = 'f'.repeat(64);

export function goldenConfigurationDocument(
  targetRepository: string,
  runtimeValidationRequired = false,
) {
  return {
    schemaVersion: 1,
    targetRepository,
    sourceRemote: 'origin',
    sourceBranch: 'main',
    taskBranchPolicy: 'foundry/<task-id>',
    roleHarness: {
      protocol: 'foundry-role-host-v1',
      command: ['foundry-role-host'],
      environmentAllowlist: ['OPENAI_API_KEY'],
    },
    timeouts: {
      roleMs: 1800000,
      settleMs: 30000,
      pollMs: 100,
      commandMs: 900000,
      runtimeReadinessMs: runtimeValidationRequired ? 250 : 120000,
      cleanupMs: 30000,
      leaseMs: 60000,
    },
    retryBudgets: { architect: 1, coder: 2, tester: 1, reviewer: 1 },
    operationalRetryBudgets: { git: 2, runtime: 1, publication: 2, cleanup: 1 },
    limits: { maxParallelCoders: 4, maxCorrectionRounds: 2, maxControlRepairsPerAttempt: 1 },
    projectProfile: {
      guidancePaths: [],
      commands: {
        bootstrap: ['bootstrap-tool', 'up'],
        formatCheck: ['fmt', '--check'],
        lint: ['lint-tool', '--strict'],
        typecheck: ['tsc', '--noEmit'],
        test: ['test-tool', 'run'],
        build: ['build-tool', 'all'],
      },
    },
    runtimeProfile: runtimeValidationRequired
      ? {
          reset: ['runtime-tool', 'reset'],
          build: ['runtime-tool', 'build'],
          start: ['runtime-tool', 'start'],
          readiness: ['runtime-tool', 'ready'],
          stop: ['runtime-tool', 'stop'],
          baseUrl: 'http://127.0.0.1:3000',
          environmentAllowlist: [],
          dataPolicy: 'preserve',
          testerAccess: 'read_only',
        }
      : null,
    decisionPublication: null,
  };
}

export function goldenConfiguration(
  targetRepository: string,
  runtimeValidationRequired = false,
): Effect.Effect<ProjectConfiguration, unknown> {
  return decodeProjectConfiguration(
    goldenConfigurationDocument(targetRepository, runtimeValidationRequired),
    targetRepository,
  );
}

function emit(runDirectory: string, createIfMissing: boolean, draft: RunEventDraft) {
  return appendRunEvent({
    runDirectory,
    runId: RUN_ID,
    createIfMissing,
    build: () => Effect.succeed(draft),
  });
}

export function seedVerifyingRun(options: {
  readonly runDirectory: string;
  readonly runtimeValidationRequired: boolean;
}) {
  const { runDirectory, runtimeValidationRequired } = options;
  return Effect.gen(function* () {
    yield* emit(runDirectory, true, {
      type: 'run-created',
      payload: { taskId: 'TASK-CHECKS' },
    });
    yield* emit(runDirectory, false, {
      type: 'source-frozen',
      payload: {
        repository: {
          repositoryRoot: '/target',
          gitDirectory: '/target/.git',
          remoteUrl: 'https://example.invalid/target.git',
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
        criteria: [{ id: 'AC-001', text: 'the seeded criterion' }],
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
        commit: IMPLEMENTED_COMMIT,
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

export function passingVerificationReport() {
  return {
    attempt: 1,
    repository: '/target',
    commit: IMPLEMENTED_COMMIT,
    profileHash: 'a'.repeat(64),
    commandMs: 900000,
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
          sha256: 'b'.repeat(64),
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
