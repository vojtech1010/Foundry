export const PRODUCT_NAME = 'Foundry';

export const WORKFLOW_ROLES = ['architect', 'coder', 'tester', 'reviewer'] as const;

export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];
