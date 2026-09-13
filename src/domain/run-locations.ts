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
