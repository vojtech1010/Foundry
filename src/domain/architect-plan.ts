import { Result, Schema } from 'effect';

export const ARCHITECT_PLAN_SCHEMA_VERSION = 1 as const;

export const ARCHITECT_PLAN_OUTCOMES = ['plan_ready', 'no_change_candidate', 'blocked'] as const;

export type ArchitectPlanOutcome = (typeof ARCHITECT_PLAN_OUTCOMES)[number];

export const ARCHITECT_RUNTIME_VALIDATION_DECISIONS = ['required', 'not_required'] as const;

export type ArchitectRuntimeValidationDecision =
  (typeof ARCHITECT_RUNTIME_VALIDATION_DECISIONS)[number];

export const ARCHITECT_EXECUTION_MODES = ['sequential', 'parallel'] as const;

export type ArchitectExecutionMode = (typeof ARCHITECT_EXECUTION_MODES)[number];

export const EXECUTION_PLAN_MODES = ['sequential', 'parallel'] as const;

export type ExecutionPlanMode = (typeof EXECUTION_PLAN_MODES)[number];

export const MAX_ACCEPTANCE_CRITERIA = 100;

export const MAX_PARALLEL_OBJECTIVES = 32;

export const MAX_OBJECTIVE_PATHS = 256;

export const ArchitectObjectiveSchema = Schema.Struct({
  title: Schema.NonEmptyString,
  affectedPaths: Schema.Array(Schema.String),
  criteria: Schema.Array(Schema.Int),
});

export type ArchitectObjective = (typeof ArchitectObjectiveSchema)['Type'];

export const ArchitectPlanReadyControlSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ARCHITECT_PLAN_SCHEMA_VERSION),
  outcome: Schema.Literal('plan_ready'),
  acceptanceCriteria: Schema.Array(Schema.String),
  runtimeValidation: Schema.Literals(ARCHITECT_RUNTIME_VALIDATION_DECISIONS),
  execution: Schema.Literals(ARCHITECT_EXECUTION_MODES),
  affectedPaths: Schema.optional(Schema.Array(Schema.String)),
  objectives: Schema.optional(Schema.Array(ArchitectObjectiveSchema)),
});

export type ArchitectPlanReadyControl = (typeof ArchitectPlanReadyControlSchema)['Type'];

export const ArchitectNoChangeControlSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ARCHITECT_PLAN_SCHEMA_VERSION),
  outcome: Schema.Literal('no_change_candidate'),
  acceptanceCriteria: Schema.Array(Schema.String),
  runtimeValidation: Schema.Literals(ARCHITECT_RUNTIME_VALIDATION_DECISIONS),
});

export type ArchitectNoChangeControl = (typeof ArchitectNoChangeControlSchema)['Type'];

export const ArchitectBlockedControlSchema = Schema.Struct({
  schemaVersion: Schema.Literal(ARCHITECT_PLAN_SCHEMA_VERSION),
  outcome: Schema.Literal('blocked'),
});

export type ArchitectBlockedControl = (typeof ArchitectBlockedControlSchema)['Type'];

export const ArchitectPlanControlSchema = Schema.Union([
  ArchitectPlanReadyControlSchema,
  ArchitectNoChangeControlSchema,
  ArchitectBlockedControlSchema,
]);

export type ArchitectPlanControl = (typeof ArchitectPlanControlSchema)['Type'];

export function criterionIdentifier(index: number): string {
  return `AC-${String(index + 1).padStart(3, '0')}`;
}

export function objectiveIdentifier(index: number): string {
  return `OBJ-${String(index + 1).padStart(3, '0')}`;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
}

/**
 * Labels the operator's criteria in order without paraphrasing them. The text
 * is retained exactly as the Architect supplied it (minus surrounding
 * whitespace), and the identifier is a stable positional label.
 */
export function labelAcceptanceCriteria(
  criteria: ReadonlyArray<string>,
): ReadonlyArray<AcceptanceCriterion> {
  return criteria.map((text, index) => ({ id: criterionIdentifier(index), text: text.trim() }));
}

export interface PlannedObjective {
  readonly id: string;
  readonly title: string;
  readonly affectedPaths: ReadonlyArray<string>;
  readonly criterionIds: ReadonlyArray<string>;
}

export interface CompiledExecutionPlan {
  readonly mode: ExecutionPlanMode;
  readonly objectives: ReadonlyArray<PlannedObjective>;
}

export type ArchitectPlanControlDecoding =
  | { readonly ok: true; readonly control: ArchitectPlanControl }
  | { readonly ok: false; readonly problem: string };

const DECODE_OPTIONS = { onExcessProperty: 'error' } as const;

export function decodeArchitectPlanControl(input: Schema.Json): ArchitectPlanControlDecoding {
  const result = Schema.decodeUnknownResult(ArchitectPlanControlSchema, DECODE_OPTIONS)(input);
  if (Result.isFailure(result)) {
    return { ok: false, problem: result.failure.message };
  }
  return { ok: true, control: result.success };
}

function isTrimmedNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function isAcceptableCriteria(criteria: ReadonlyArray<string>): boolean {
  if (criteria.length < 1 || criteria.length > MAX_ACCEPTANCE_CRITERIA) {
    return false;
  }
  return criteria.every(isTrimmedNonEmpty);
}

/**
 * Normalizes a repository-relative path prefix. Returns `null` for unsafe or
 * malformed input. `.` denotes the entire repository.
 */
export function normalizeRepositoryPath(path: string): string | null {
  if (path.includes('\\')) {
    return null;
  }
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith('/')) {
    return null;
  }
  if (/^[A-Za-z]:/u.test(trimmed)) {
    return null;
  }
  if (/[*?[\]{}]/u.test(trimmed)) {
    return null;
  }
  const segments = trimmed.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    return null;
  }
  if (segments.length === 0) {
    return '.';
  }
  return segments.join('/');
}

export function normalizeRepositoryPaths(
  paths: ReadonlyArray<string>,
): ReadonlyArray<string> | null {
  const normalized: Array<string> = [];
  for (const path of paths) {
    const candidate = normalizeRepositoryPath(path);
    if (candidate === null) {
      return null;
    }
    if (!normalized.includes(candidate)) {
      normalized.push(candidate);
    }
  }
  return normalized;
}

export function repositoryPathsOverlap(left: string, right: string): boolean {
  if (left === '.' || right === '.') {
    return true;
  }
  if (left === right) {
    return true;
  }
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function objectivesAreIndependent(
  objectives: ReadonlyArray<{ readonly affectedPaths: ReadonlyArray<string> }>,
): boolean {
  for (let left = 0; left < objectives.length; left += 1) {
    for (let right = left + 1; right < objectives.length; right += 1) {
      const leftPaths = objectives[left]?.affectedPaths ?? [];
      const rightPaths = objectives[right]?.affectedPaths ?? [];
      for (const leftPath of leftPaths) {
        for (const rightPath of rightPaths) {
          if (repositoryPathsOverlap(leftPath, rightPath)) {
            return false;
          }
        }
      }
    }
  }
  return true;
}

function criteriaIdsOf(criteria: ReadonlyArray<string>): ReadonlyArray<string> {
  return criteria.map((_, index) => criterionIdentifier(index));
}

function wholeRepository(paths: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  if (paths === undefined) {
    return ['.'];
  }
  const normalized = normalizeRepositoryPaths(paths);
  if (normalized === null || normalized.length === 0) {
    return ['.'];
  }
  return normalized;
}

function sequentialExecutionPlan(
  criteria: ReadonlyArray<string>,
  affectedPaths: ReadonlyArray<string> | undefined,
): CompiledExecutionPlan {
  return {
    mode: 'sequential',
    objectives: [
      {
        id: objectiveIdentifier(0),
        title: 'Implement the accepted plan',
        affectedPaths: wholeRepository(affectedPaths),
        criterionIds: criteriaIdsOf(criteria),
      },
    ],
  };
}

function compileParallel(
  criteria: ReadonlyArray<string>,
  objectives: ReadonlyArray<ArchitectObjective> | undefined,
): CompiledExecutionPlan | null {
  if (objectives === undefined) {
    return null;
  }
  if (objectives.length < 2 || objectives.length > MAX_PARALLEL_OBJECTIVES) {
    return null;
  }
  const criterionIds = criteriaIdsOf(criteria);
  const assigned = new Set<string>();
  const planned: Array<PlannedObjective> = [];
  for (const [index, objective] of objectives.entries()) {
    if (!isTrimmedNonEmpty(objective.title)) {
      return null;
    }
    if (
      objective.affectedPaths.length < 1 ||
      objective.affectedPaths.length > MAX_OBJECTIVE_PATHS
    ) {
      return null;
    }
    const normalizedPaths = normalizeRepositoryPaths(objective.affectedPaths);
    if (normalizedPaths === null || normalizedPaths.length === 0) {
      return null;
    }
    if (objective.criteria.length < 1) {
      return null;
    }
    const objectiveCriterionIds: Array<string> = [];
    for (const oneBasedIndex of objective.criteria) {
      const criterionId = criterionIds[oneBasedIndex - 1];
      if (criterionId === undefined) {
        return null;
      }
      if (assigned.has(criterionId)) {
        return null;
      }
      assigned.add(criterionId);
      objectiveCriterionIds.push(criterionId);
    }
    planned.push({
      id: objectiveIdentifier(index),
      title: objective.title.trim(),
      affectedPaths: normalizedPaths,
      criterionIds: objectiveCriterionIds,
    });
  }
  if (assigned.size !== criterionIds.length) {
    return null;
  }
  if (!objectivesAreIndependent(planned)) {
    return null;
  }
  return { mode: 'parallel', objectives: planned };
}

/**
 * Compiles the accepted Architect control into either one sequential objective
 * covering every criterion or a proven-independent parallel set. Missing,
 * empty, duplicate, overlapping, incomplete, or otherwise unsafe metadata
 * falls back to one sequential objective; this function never asks a person
 * and there is no operator flag that forces parallelism.
 */
export function compileExecutionPlan(control: ArchitectPlanControl): CompiledExecutionPlan {
  if (control.outcome === 'blocked') {
    return sequentialExecutionPlan([], undefined);
  }
  if (!isAcceptableCriteria(control.acceptanceCriteria)) {
    return sequentialExecutionPlan(control.acceptanceCriteria, undefined);
  }
  if (control.outcome === 'plan_ready' && control.execution === 'parallel') {
    const parallel = compileParallel(control.acceptanceCriteria, control.objectives);
    if (parallel !== null) {
      return parallel;
    }
  }
  return sequentialExecutionPlan(
    control.acceptanceCriteria,
    control.outcome === 'plan_ready' ? control.affectedPaths : undefined,
  );
}

export function planRequiresImplementation(control: ArchitectPlanControl): boolean {
  return control.outcome === 'plan_ready';
}

export function planRuntimeValidationRequired(control: ArchitectPlanControl): boolean {
  if (control.outcome === 'blocked') {
    return false;
  }
  return control.runtimeValidation === 'required';
}
