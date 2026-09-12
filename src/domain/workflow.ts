import { Schema } from 'effect';

import { Identifier } from './run-identity.js';

export const PRODUCT_NAME = 'Foundry';

export const WORKFLOW_ROLES = ['architect', 'coder', 'tester', 'reviewer'] as const;

export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

export const WORKFLOW_STATES = [
  'planning',
  'coding',
  'verifying',
  'testing',
  'reviewing',
  'correcting',
  'human_decision_required',
  'publishing',
  'completed',
  'completed_no_change',
  'abandoned',
  'blocked',
  'failed',
  'publish_failed',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WorkflowStateSchema = Schema.Literals(WORKFLOW_STATES);

export const ACTIVE_WORKFLOW_STATES = [
  'planning',
  'coding',
  'verifying',
  'testing',
  'reviewing',
  'correcting',
] as const satisfies ReadonlyArray<WorkflowState>;

export const DECISION_OR_PUBLICATION_WORKFLOW_STATES = [
  'human_decision_required',
  'publishing',
] as const satisfies ReadonlyArray<WorkflowState>;

export const SUCCESS_WORKFLOW_STATES = [
  'completed',
  'completed_no_change',
] as const satisfies ReadonlyArray<WorkflowState>;

export const RECOVERABLE_WORKFLOW_STATES = [
  'blocked',
  'publish_failed',
] as const satisfies ReadonlyArray<WorkflowState>;

export const TERMINAL_WORKFLOW_STATES = [
  'completed',
  'completed_no_change',
  'abandoned',
  'failed',
] as const satisfies ReadonlyArray<WorkflowState>;

export const INITIAL_WORKFLOW_STATE: WorkflowState = 'planning';

export const WORKFLOW_STATE_SCHEMA_VERSION = 1 as const;

export const WORKFLOW_STATE_FILENAME = 'workflow-state.json' as const;

export const WorkflowStateDocumentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(WORKFLOW_STATE_SCHEMA_VERSION),
  runId: Identifier,
  state: WorkflowStateSchema,
});

export type WorkflowStateDocument = (typeof WorkflowStateDocumentSchema)['Type'];
