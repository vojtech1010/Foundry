import { TASK_ID_PLACEHOLDER } from './project-configuration.js';

export const WORKTREES_DIRECTORY_NAME = 'worktrees' as const;

export const RUNS_DIRECTORY_NAME = 'runs' as const;

export function renderTaskBranch(taskBranchPolicy: string, taskId: string): string {
  return taskBranchPolicy.split(TASK_ID_PLACEHOLDER).join(taskId);
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
