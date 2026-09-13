import { Schema } from 'effect';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { RUN_STORAGE_DIRECTORY_NAME } from './readiness.js';
import { TASK_ID_PLACEHOLDER } from './project-configuration.js';

export const WORKTREES_DIRECTORY_NAME = 'worktrees' as const;

export const RUNS_DIRECTORY_NAME = 'runs' as const;

export function renderTaskBranch(taskBranchPolicy: string, taskId: string): string {
  return taskBranchPolicy.split(TASK_ID_PLACEHOLDER).join(taskId);
}

export function renderWorkspacePath(targetRepository: string, taskId: string): string {
  return join(targetRepository, RUN_STORAGE_DIRECTORY_NAME, WORKTREES_DIRECTORY_NAME, taskId);
}

const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export const GitCommitId = Schema.String.check(Schema.isPattern(GIT_COMMIT_PATTERN));

export function isGitCommitId(value: string): boolean {
  return GIT_COMMIT_PATTERN.test(value);
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function hasControlOrSpace(name: string): boolean {
  for (const character of name) {
    if (character === ' ') {
      return true;
    }
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const FORBIDDEN_CHARACTER_PATTERN = /[~^:?*\\[]/u;

export function isLegalGitBranchName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  if (name === '@') {
    return false;
  }
  if (name.startsWith('/') || name.endsWith('/')) {
    return false;
  }
  if (name.startsWith('.') || name.endsWith('.')) {
    return false;
  }
  if (name.endsWith('.lock')) {
    return false;
  }
  if (name.includes('..')) {
    return false;
  }
  if (name.includes('@{')) {
    return false;
  }
  if (name.includes('//')) {
    return false;
  }
  if (hasControlOrSpace(name)) {
    return false;
  }
  if (FORBIDDEN_CHARACTER_PATTERN.test(name)) {
    return false;
  }
  return true;
}

export type BranchProtectionEvidence =
  | { readonly _tag: 'NotConfigured' }
  | { readonly _tag: 'Known'; readonly protectedBranches: ReadonlyArray<string> }
  | { readonly _tag: 'Uncertain'; readonly reason: string };

export const BRANCH_PROTECTION_NOT_CONFIGURED: BranchProtectionEvidence = {
  _tag: 'NotConfigured',
};

export function branchProtectionEvidenceForPublication(
  publicationConfigured: boolean,
): BranchProtectionEvidence {
  return publicationConfigured
    ? {
        _tag: 'Uncertain',
        reason:
          'protection evidence for the configured publication was not resolved before branch preflight',
      }
    : BRANCH_PROTECTION_NOT_CONFIGURED;
}

export type TaskBranchPreflightRejection =
  | { readonly _tag: 'SourceBranch'; readonly taskBranch: string; readonly message: string }
  | { readonly _tag: 'IllegalName'; readonly taskBranch: string; readonly message: string }
  | {
      readonly _tag: 'ProtectedBranch';
      readonly taskBranch: string;
      readonly protectedBranch: string;
      readonly message: string;
    }
  | {
      readonly _tag: 'ProtectionUncertain';
      readonly taskBranch: string;
      readonly reason: string;
      readonly message: string;
    };

export type TaskBranchPreflight =
  | { readonly _tag: 'Accepted'; readonly taskBranch: string }
  | { readonly _tag: 'Rejected'; readonly rejection: TaskBranchPreflightRejection };

export function preflightTaskBranch(input: {
  readonly taskBranch: string;
  readonly sourceBranch: string;
  readonly protection: BranchProtectionEvidence;
}): TaskBranchPreflight {
  const { taskBranch, sourceBranch, protection } = input;
  if (taskBranch === sourceBranch) {
    return {
      _tag: 'Rejected',
      rejection: {
        _tag: 'SourceBranch',
        taskBranch,
        message: `Rendered task branch "${taskBranch}" must not equal source branch "${sourceBranch}".`,
      },
    };
  }
  if (!isLegalGitBranchName(taskBranch)) {
    return {
      _tag: 'Rejected',
      rejection: {
        _tag: 'IllegalName',
        taskBranch,
        message: `Rendered task branch "${taskBranch}" is not a legal Git branch name.`,
      },
    };
  }
  if (protection._tag === 'Uncertain') {
    return {
      _tag: 'Rejected',
      rejection: {
        _tag: 'ProtectionUncertain',
        taskBranch,
        reason: protection.reason,
        message: `Task branch "${taskBranch}" cannot be checked against GitHub protected branches: ${protection.reason}.`,
      },
    };
  }
  if (protection._tag === 'Known' && protection.protectedBranches.includes(taskBranch)) {
    return {
      _tag: 'Rejected',
      rejection: {
        _tag: 'ProtectedBranch',
        taskBranch,
        protectedBranch: taskBranch,
        message: `Task branch "${taskBranch}" collides with a protected branch reported by GitHub.`,
      },
    };
  }
  return { _tag: 'Accepted', taskBranch };
}
