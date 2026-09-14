import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Schema } from 'effect';
import {
  InvalidProjectConfiguration,
  decodeProjectConfiguration,
} from '../src/application/project-configuration.js';
import {
  HARDCODED_ARTIFACT_BOUNDS,
  PROJECT_CONFIGURATION_SCHEMA_VERSION,
  PUBLICATION_DRAFT,
  PUBLICATION_MAINTAINERS_CAN_MODIFY,
  ROLE_HARNESS_PROTOCOL,
  RUNTIME_DATA_POLICY,
  RUNTIME_TESTER_ACCESS,
  TASK_ID_PLACEHOLDER,
  VERIFICATION_COMMANDS,
} from '../src/domain/project-configuration.js';

const configDirectory = join(tmpdir(), 'foundry-project-configuration-tests', '.agent');

const exampleConfiguration = {
  schemaVersion: 1,
  targetRepository: '..',
  sourceRemote: 'origin',
  sourceBranch: 'main',
  taskBranchPolicy: 'foundry/<task-id>',
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
  retryBudgets: {
    architect: 1,
    coder: 2,
    tester: 1,
    reviewer: 1,
  },
  operationalRetryBudgets: {
    git: 2,
    runtime: 1,
    publication: 2,
    cleanup: 1,
  },
  limits: {
    maxParallelCoders: 4,
    maxCorrectionRounds: 2,
    maxControlRepairsPerAttempt: 1,
  },
  projectProfile: {
    guidancePaths: [],
    commands: {
      bootstrap: ['npm', 'ci'],
      formatCheck: ['npm', 'run', 'format:check'],
      lint: ['npm', 'run', 'lint'],
      typecheck: ['npm', 'run', 'typecheck'],
      test: ['npm', 'test'],
      build: ['npm', 'run', 'build'],
    },
  },
  runtimeProfile: {
    reset: ['npm', 'run', 'runtime:reset'],
    build: ['npm', 'run', 'build'],
    start: ['npm', 'run', 'runtime:start'],
    readiness: ['npm', 'run', 'runtime:ready'],
    stop: ['npm', 'run', 'runtime:stop'],
    baseUrl: 'http://127.0.0.1:3000',
    environmentAllowlist: [],
    dataPolicy: 'preserve',
    testerAccess: 'read_only',
  },
  decisionPublication: {
    remote: 'origin',
    draft: true,
    maintainersCanModify: false,
  },
} as const;

interface InvalidCase {
  readonly label: string;
  readonly document: Schema.Json;
  readonly field: string;
}

function withoutKey(source: Record<string, Schema.Json>, key: string): Schema.Json {
  return Object.fromEntries(Object.entries(source).filter(([name]) => name !== key));
}

const sections: ReadonlyArray<readonly [string, Record<string, Schema.Json>]> = [
  ['roles', exampleConfiguration.roles],
  ['timeouts', exampleConfiguration.timeouts],
  ['retryBudgets', exampleConfiguration.retryBudgets],
  ['operationalRetryBudgets', exampleConfiguration.operationalRetryBudgets],
  ['limits', exampleConfiguration.limits],
  ['projectProfile', exampleConfiguration.projectProfile],
  ['runtimeProfile', exampleConfiguration.runtimeProfile],
  ['decisionPublication', exampleConfiguration.decisionPublication],
];

function expectInvalidConfiguration(document: Schema.Json, label: string) {
  return Effect.gen(function* () {
    const error = yield* decodeProjectConfiguration(document, configDirectory).pipe(Effect.flip);
    expect(error, label).toBeInstanceOf(InvalidProjectConfiguration);
    expect(error.expectedSchemaVersion, label).toBe(PROJECT_CONFIGURATION_SCHEMA_VERSION);
    expect(error.message, label).toContain(
      `Expected schemaVersion ${PROJECT_CONFIGURATION_SCHEMA_VERSION}`,
    );
    return error;
  });
}

const unknownFieldCases: ReadonlyArray<InvalidCase> = [
  {
    label: 'extra top-level field',
    document: { ...exampleConfiguration, extra: true },
    field: 'extra',
  },
  {
    label: 'manual mode field',
    document: { ...exampleConfiguration, manual: true },
    field: 'manual',
  },
  { label: 'pilot mode field', document: { ...exampleConfiguration, pilot: true }, field: 'pilot' },
  {
    label: 'shadow mode field',
    document: { ...exampleConfiguration, shadow: true },
    field: 'shadow',
  },
  {
    label: 'adoption mode field',
    document: { ...exampleConfiguration, adoption: true },
    field: 'adoption',
  },
  {
    label: 'operating mode field',
    document: { ...exampleConfiguration, operatingMode: 'autonomous' },
    field: 'operatingMode',
  },
  {
    label: 'unknown timeout field',
    document: {
      ...exampleConfiguration,
      timeouts: { ...exampleConfiguration.timeouts, pollIntervalMs: 100 },
    },
    field: 'timeouts.pollIntervalMs',
  },
  {
    label: 'unknown retry budget field',
    document: {
      ...exampleConfiguration,
      retryBudgets: { ...exampleConfiguration.retryBudgets, planner: 1 },
    },
    field: 'retryBudgets.planner',
  },
  {
    label: 'unknown operational retry budget field',
    document: {
      ...exampleConfiguration,
      operationalRetryBudgets: { ...exampleConfiguration.operationalRetryBudgets, fetch: 1 },
    },
    field: 'operationalRetryBudgets.fetch',
  },
  {
    label: 'unknown limit field',
    document: { ...exampleConfiguration, limits: { ...exampleConfiguration.limits, maxRuns: 3 } },
    field: 'limits.maxRuns',
  },
  {
    label: 'unknown project profile field',
    document: {
      ...exampleConfiguration,
      projectProfile: { ...exampleConfiguration.projectProfile, packageManager: 'npm' },
    },
    field: 'projectProfile.packageManager',
  },
  {
    label: 'unknown command field',
    document: {
      ...exampleConfiguration,
      projectProfile: {
        ...exampleConfiguration.projectProfile,
        commands: {
          ...exampleConfiguration.projectProfile.commands,
          coverage: ['npm', 'run', 'coverage'],
        },
      },
    },
    field: 'projectProfile.commands.coverage',
  },
  {
    label: 'unknown runtime field',
    document: {
      ...exampleConfiguration,
      runtimeProfile: { ...exampleConfiguration.runtimeProfile, healthPath: '/health' },
    },
    field: 'runtimeProfile.healthPath',
  },
  {
    label: 'unknown publication field',
    document: {
      ...exampleConfiguration,
      decisionPublication: { ...exampleConfiguration.decisionPublication, labels: ['foundry'] },
    },
    field: 'decisionPublication.labels',
  },
  {
    label: 'artifacts block is not part of the configuration document',
    document: {
      ...exampleConfiguration,
      artifacts: { ...HARDCODED_ARTIFACT_BOUNDS },
    },
    field: 'artifacts',
  },
];

const mistypedFieldCases: ReadonlyArray<InvalidCase> = [
  {
    label: 'schemaVersion 2',
    document: { ...exampleConfiguration, schemaVersion: 2 },
    field: 'schemaVersion',
  },
  {
    label: 'schemaVersion string',
    document: { ...exampleConfiguration, schemaVersion: '1' },
    field: 'schemaVersion',
  },
  {
    label: 'target repository number',
    document: { ...exampleConfiguration, targetRepository: 7 },
    field: 'targetRepository',
  },
  {
    label: 'empty target repository',
    document: { ...exampleConfiguration, targetRepository: '' },
    field: 'targetRepository',
  },
  {
    label: 'empty source remote',
    document: { ...exampleConfiguration, sourceRemote: '' },
    field: 'sourceRemote',
  },
  {
    label: 'empty source branch',
    document: { ...exampleConfiguration, sourceBranch: '' },
    field: 'sourceBranch',
  },
  {
    label: 'timeout as float',
    document: {
      ...exampleConfiguration,
      timeouts: { ...exampleConfiguration.timeouts, roleMs: 1.5 },
    },
    field: 'timeouts.roleMs',
  },
  {
    label: 'timeout as zero',
    document: {
      ...exampleConfiguration,
      timeouts: { ...exampleConfiguration.timeouts, roleMs: 0 },
    },
    field: 'timeouts.roleMs',
  },
  {
    label: 'timeout as negative',
    document: {
      ...exampleConfiguration,
      timeouts: { ...exampleConfiguration.timeouts, settleMs: -1 },
    },
    field: 'timeouts.settleMs',
  },
  {
    label: 'timeout as string',
    document: {
      ...exampleConfiguration,
      timeouts: { ...exampleConfiguration.timeouts, pollMs: '100' },
    },
    field: 'timeouts.pollMs',
  },
  {
    label: 'negative retry budget',
    document: {
      ...exampleConfiguration,
      retryBudgets: { ...exampleConfiguration.retryBudgets, architect: -1 },
    },
    field: 'retryBudgets.architect',
  },
  {
    label: 'fractional retry budget',
    document: {
      ...exampleConfiguration,
      retryBudgets: { ...exampleConfiguration.retryBudgets, coder: 0.5 },
    },
    field: 'retryBudgets.coder',
  },
  {
    label: 'negative operational retry budget',
    document: {
      ...exampleConfiguration,
      operationalRetryBudgets: { ...exampleConfiguration.operationalRetryBudgets, git: -1 },
    },
    field: 'operationalRetryBudgets.git',
  },
  {
    label: 'zero parallel coders',
    document: {
      ...exampleConfiguration,
      limits: { ...exampleConfiguration.limits, maxParallelCoders: 0 },
    },
    field: 'limits.maxParallelCoders',
  },
  {
    label: 'negative correction rounds',
    document: {
      ...exampleConfiguration,
      limits: { ...exampleConfiguration.limits, maxCorrectionRounds: -1 },
    },
    field: 'limits.maxCorrectionRounds',
  },
  {
    label: 'guidance paths as string',
    document: {
      ...exampleConfiguration,
      projectProfile: { ...exampleConfiguration.projectProfile, guidancePaths: 'AGENTS.md' },
    },
    field: 'projectProfile.guidancePaths',
  },
  {
    label: 'empty guidance path',
    document: {
      ...exampleConfiguration,
      projectProfile: { ...exampleConfiguration.projectProfile, guidancePaths: [''] },
    },
    field: 'projectProfile.guidancePaths.0',
  },
  {
    label: 'empty bootstrap vector',
    document: {
      ...exampleConfiguration,
      projectProfile: {
        ...exampleConfiguration.projectProfile,
        commands: { ...exampleConfiguration.projectProfile.commands, bootstrap: [] },
      },
    },
    field: 'projectProfile.commands.bootstrap.0',
  },
  {
    label: 'empty bootstrap argument',
    document: {
      ...exampleConfiguration,
      projectProfile: {
        ...exampleConfiguration.projectProfile,
        commands: { ...exampleConfiguration.projectProfile.commands, bootstrap: ['npm', ''] },
      },
    },
    field: 'projectProfile.commands.bootstrap.1',
  },
  {
    label: 'empty verification vector',
    document: {
      ...exampleConfiguration,
      projectProfile: {
        ...exampleConfiguration.projectProfile,
        commands: { ...exampleConfiguration.projectProfile.commands, formatCheck: [] },
      },
    },
    field: 'projectProfile.commands.formatCheck.0',
  },
  {
    label: 'non-string verification argument',
    document: {
      ...exampleConfiguration,
      projectProfile: {
        ...exampleConfiguration.projectProfile,
        commands: { ...exampleConfiguration.projectProfile.commands, lint: ['npm', 7] },
      },
    },
    field: 'projectProfile.commands.lint.1',
  },
  {
    label: 'unsupported runtime data policy',
    document: {
      ...exampleConfiguration,
      runtimeProfile: { ...exampleConfiguration.runtimeProfile, dataPolicy: 'wipe' },
    },
    field: 'runtimeProfile.dataPolicy',
  },
  {
    label: 'unsupported tester access',
    document: {
      ...exampleConfiguration,
      runtimeProfile: { ...exampleConfiguration.runtimeProfile, testerAccess: 'read_write' },
    },
    field: 'runtimeProfile.testerAccess',
  },
  {
    label: 'empty runtime base url',
    document: {
      ...exampleConfiguration,
      runtimeProfile: { ...exampleConfiguration.runtimeProfile, baseUrl: '' },
    },
    field: 'runtimeProfile.baseUrl',
  },
  {
    label: 'empty runtime command vector',
    document: {
      ...exampleConfiguration,
      runtimeProfile: { ...exampleConfiguration.runtimeProfile, reset: [] },
    },
    field: 'runtimeProfile.reset.0',
  },
  {
    label: 'runtime command as string',
    document: {
      ...exampleConfiguration,
      runtimeProfile: { ...exampleConfiguration.runtimeProfile, stop: 'npm run runtime:stop' },
    },
    field: 'runtimeProfile.stop',
  },
];

describe('project configuration contract', () => {
  it('publishes the closed vocabulary', () => {
    expect(PROJECT_CONFIGURATION_SCHEMA_VERSION).toBe(1);
    expect(ROLE_HARNESS_PROTOCOL).toBe('foundry-role-host-v1');
    expect(PUBLICATION_DRAFT).toBe(true);
    expect(PUBLICATION_MAINTAINERS_CAN_MODIFY).toBe(false);
    expect(RUNTIME_DATA_POLICY).toBe('preserve');
    expect(RUNTIME_TESTER_ACCESS).toBe('read_only');
    expect(TASK_ID_PLACEHOLDER).toBe('<task-id>');
    expect(VERIFICATION_COMMANDS).toEqual(['formatCheck', 'lint', 'typecheck', 'test', 'build']);
  });

  it.effect('accepts the golden configuration document', () =>
    Effect.gen(function* () {
      const decoded = yield* decodeProjectConfiguration(exampleConfiguration, configDirectory);

      expect(decoded.schemaVersion).toBe(1);
      expect(decoded.targetRepository).toBe(resolve(configDirectory, '..'));
      expect(decoded.sourceRemote).toBe('origin');
      expect(decoded.sourceBranch).toBe('main');
      expect(decoded.taskBranchPolicy).toBe('foundry/<task-id>');
      expect(decoded.roles).toEqual({
        architect: { harness: 'codex', model: 'gpt-5-codex' },
        coder: { harness: 'codex', model: 'gpt-5-codex' },
        lead_coder: { harness: 'opencode', model: 'openai/gpt-5' },
        tester: { harness: 'opencode', model: 'openai/gpt-5' },
        reviewer: { harness: 'codex', model: 'gpt-5-codex' },
      });
      expect(decoded.timeouts).toEqual(exampleConfiguration.timeouts);
      expect(decoded.retryBudgets).toEqual(exampleConfiguration.retryBudgets);
      expect(decoded.operationalRetryBudgets).toEqual(exampleConfiguration.operationalRetryBudgets);
      expect(decoded.limits).toEqual(exampleConfiguration.limits);
      expect(decoded.projectProfile.guidancePaths).toEqual([]);
      expect(decoded.projectProfile.commands).toEqual(exampleConfiguration.projectProfile.commands);
      expect(decoded.runtimeProfile).toEqual(exampleConfiguration.runtimeProfile);
      expect(decoded.decisionPublication).toEqual(exampleConfiguration.decisionPublication);
      expect(decoded.artifacts).toEqual({ ...HARDCODED_ARTIFACT_BOUNDS });
    }),
  );

  it.effect('injects the immutable hardcoded artifact bounds', () =>
    Effect.gen(function* () {
      const decoded = yield* decodeProjectConfiguration(exampleConfiguration, configDirectory);

      expect(decoded.artifacts).toEqual({
        retentionDays: 30,
        maxRequestBytes: 262144,
        maxGuidanceBytes: 1048576,
        maxRoleHandoffBytes: 262144,
        maxEvidenceBytes: 26214400,
        maxTerminalCaptureBytes: 10485760,
        maxRunBytes: 104857600,
        redactionPatterns: [],
      });
      expect(decoded.artifacts).toEqual({ ...HARDCODED_ARTIFACT_BOUNDS });
    }),
  );

  it.effect('rejects a document carrying the removed artifacts block', () =>
    Effect.gen(function* () {
      const error = yield* expectInvalidConfiguration(
        { ...exampleConfiguration, artifacts: { ...HARDCODED_ARTIFACT_BOUNDS } },
        'artifacts block',
      );
      expect(error.field).toBe('artifacts');
    }),
  );

  it.effect('rejects a document carrying the removed roleHarness block', () =>
    Effect.gen(function* () {
      const error = yield* expectInvalidConfiguration(
        {
          ...exampleConfiguration,
          roleHarness: {
            protocol: 'foundry-role-host-v1',
            command: ['foundry-role-host'],
            environmentAllowlist: ['OPENAI_API_KEY'],
          },
        },
        'roleHarness block',
      );
      expect(error.field).toBe('roleHarness');
    }),
  );

  it.effect('accepts null runtime and publication with zero-valued budgets', () =>
    Effect.gen(function* () {
      const decoded = yield* decodeProjectConfiguration(
        {
          ...exampleConfiguration,
          retryBudgets: { architect: 0, coder: 0, tester: 0, reviewer: 0 },
          operationalRetryBudgets: { git: 0, runtime: 0, publication: 0, cleanup: 0 },
          limits: { maxParallelCoders: 1, maxCorrectionRounds: 0, maxControlRepairsPerAttempt: 0 },
          projectProfile: {
            ...exampleConfiguration.projectProfile,
            commands: { ...exampleConfiguration.projectProfile.commands, bootstrap: null },
          },
          runtimeProfile: null,
          decisionPublication: null,
        },
        configDirectory,
      );

      expect(decoded.runtimeProfile).toBeNull();
      expect(decoded.decisionPublication).toBeNull();
      expect(decoded.projectProfile.commands.bootstrap).toBeNull();
      expect(decoded.retryBudgets).toEqual({ architect: 0, coder: 0, tester: 0, reviewer: 0 });
      expect(decoded.operationalRetryBudgets).toEqual({
        git: 0,
        runtime: 0,
        publication: 0,
        cleanup: 0,
      });
      expect(decoded.limits).toEqual({
        maxParallelCoders: 1,
        maxCorrectionRounds: 0,
        maxControlRepairsPerAttempt: 0,
      });
      expect(decoded.artifacts).toEqual({ ...HARDCODED_ARTIFACT_BOUNDS });
      expect(decoded.artifacts.retentionDays).toBe(30);
    }),
  );

  it.effect('rejects unknown fields at every object level', () =>
    Effect.gen(function* () {
      for (const testCase of unknownFieldCases) {
        const error = yield* expectInvalidConfiguration(testCase.document, testCase.label);
        expect(error.field, testCase.label).toBe(testCase.field);
      }
    }),
  );

  it.effect('rejects a document missing any required key', () =>
    Effect.gen(function* () {
      for (const key of Object.keys(exampleConfiguration)) {
        const error = yield* expectInvalidConfiguration(
          withoutKey(exampleConfiguration, key),
          `missing ${key}`,
        );
        expect(error.field, `missing ${key}`).toBe(key);
      }

      for (const [section, source] of sections) {
        for (const key of Object.keys(source)) {
          const document = { ...exampleConfiguration, [section]: withoutKey(source, key) };
          const error = yield* expectInvalidConfiguration(document, `missing ${section}.${key}`);
          expect(error.field, `missing ${section}.${key}`).toBe(`${section}.${key}`);
        }
      }
    }),
  );

  it.effect('rejects mistyped and out-of-range values', () =>
    Effect.gen(function* () {
      for (const testCase of mistypedFieldCases) {
        const error = yield* expectInvalidConfiguration(testCase.document, testCase.label);
        expect(error.field, testCase.label).toBe(testCase.field);
      }
    }),
  );

  it.effect('requires the five verification commands and allows only null bootstrap', () =>
    Effect.gen(function* () {
      for (const command of VERIFICATION_COMMANDS) {
        const document = {
          ...exampleConfiguration,
          projectProfile: {
            ...exampleConfiguration.projectProfile,
            commands: withoutKey(exampleConfiguration.projectProfile.commands, command),
          },
        };
        const error = yield* expectInvalidConfiguration(document, `missing ${command}`);
        expect(error.field, `missing ${command}`).toBe(`projectProfile.commands.${command}`);
      }

      const withoutBootstrap = {
        ...exampleConfiguration,
        projectProfile: {
          ...exampleConfiguration.projectProfile,
          commands: withoutKey(exampleConfiguration.projectProfile.commands, 'bootstrap'),
        },
      };
      const bootstrapError = yield* expectInvalidConfiguration(
        withoutBootstrap,
        'missing bootstrap',
      );
      expect(bootstrapError.field).toBe('projectProfile.commands.bootstrap');
    }),
  );

  it.effect('requires exactly one task id placeholder in the branch policy', () =>
    Effect.gen(function* () {
      for (const policy of ['foundry/task', 'foundry/<task-id>/<task-id>', '']) {
        const error = yield* expectInvalidConfiguration(
          { ...exampleConfiguration, taskBranchPolicy: policy },
          policy,
        );
        expect(error.field, policy).toBe('taskBranchPolicy');
      }
    }),
  );

  it.effect('restricts decision publication to immutable drafts of the source remote', () =>
    Effect.gen(function* () {
      const invalidPublications = [
        {
          label: 'non-draft publication',
          publication: { remote: 'origin', draft: false, maintainersCanModify: false },
          field: 'decisionPublication.draft',
        },
        {
          label: 'maintainer-modifiable publication',
          publication: { remote: 'origin', draft: true, maintainersCanModify: true },
          field: 'decisionPublication.maintainersCanModify',
        },
        {
          label: 'publication remote mismatch',
          publication: { remote: 'upstream', draft: true, maintainersCanModify: false },
          field: 'decisionPublication.remote',
        },
      ];

      for (const testCase of invalidPublications) {
        const error = yield* expectInvalidConfiguration(
          { ...exampleConfiguration, decisionPublication: testCase.publication },
          testCase.label,
        );
        expect(error.field, testCase.label).toBe(testCase.field);
      }

      const decoded = yield* decodeProjectConfiguration(
        {
          ...exampleConfiguration,
          decisionPublication: { remote: 'origin', draft: true, maintainersCanModify: false },
        },
        configDirectory,
      );
      expect(decoded.decisionPublication).toEqual({
        remote: 'origin',
        draft: true,
        maintainersCanModify: false,
      });
    }),
  );

  it.effect('resolves configuration-relative paths and leaves other commands alone', () =>
    Effect.gen(function* () {
      const decoded = yield* decodeProjectConfiguration(
        {
          ...exampleConfiguration,
          targetRepository: '..',
          projectProfile: {
            ...exampleConfiguration.projectProfile,
            guidancePaths: ['AGENTS.md', 'docs/agents.md'],
          },
        },
        configDirectory,
      );

      expect(decoded.targetRepository).toBe(resolve(configDirectory, '..'));
      expect(decoded.projectProfile.guidancePaths).toEqual([
        resolve(configDirectory, 'AGENTS.md'),
        resolve(configDirectory, 'docs/agents.md'),
      ]);
      expect(decoded.projectProfile.commands).toEqual(exampleConfiguration.projectProfile.commands);
      expect(decoded.runtimeProfile?.reset).toEqual(exampleConfiguration.runtimeProfile.reset);
    }),
  );

  it.effect('rejects incomplete runtime profiles and non-object documents', () =>
    Effect.gen(function* () {
      const emptyRuntimeError = yield* expectInvalidConfiguration(
        { ...exampleConfiguration, runtimeProfile: {} },
        'empty runtime profile',
      );
      expect(emptyRuntimeError.field).toBe('runtimeProfile.reset');

      const arrayDocumentError = yield* expectInvalidConfiguration([], 'array document');
      expect(arrayDocumentError.message).toContain('Invalid project configuration');

      const stringDocumentError = yield* expectInvalidConfiguration('{}', 'string document');
      expect(stringDocumentError.message).toContain('Invalid project configuration');
    }),
  );
});
