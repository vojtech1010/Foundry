export const SUPPORTED_PLATFORMS = ['linux', 'win32'] as const;

export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export const REQUIRED_NODE_VERSION = '24.14.0' as const;

export const REQUIRED_NPM_VERSION = '11.9.0' as const;

export const MINIMUM_GIT_MAJOR = 2 as const;

export const MINIMUM_GIT_MINOR = 43 as const;

export function isSupportedPlatform(platform: string): platform is SupportedPlatform {
  return SUPPORTED_PLATFORMS.some((supported) => supported === platform);
}

export function displayPlatform(platform: string): string {
  return platform === 'win32' ? 'windows' : platform;
}

export function normalizeToolVersion(output: string): string {
  const trimmed = output.trim();
  return trimmed.startsWith('v') ? trimmed.slice(1) : trimmed;
}

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
}

const GIT_VERSION_PATTERN = /git version (\d+)\.(\d+)/u;

const GIT_VERSION_NUMBER_PATTERN = /git version (\d+\.\d+(?:\.\d+)?)/u;

export function parseGitVersion(output: string): GitVersion | undefined {
  const match = GIT_VERSION_PATTERN.exec(output);
  if (match === null) {
    return undefined;
  }
  const major = Number.parseInt(match[1] ?? '', 10);
  const minor = Number.parseInt(match[2] ?? '', 10);
  if (Number.isInteger(major) && Number.isInteger(minor)) {
    return { major, minor };
  }
  return undefined;
}

export function isSupportedGitVersion(version: GitVersion): boolean {
  if (version.major > MINIMUM_GIT_MAJOR) {
    return true;
  }
  return version.major === MINIMUM_GIT_MAJOR && version.minor >= MINIMUM_GIT_MINOR;
}

export function extractGitVersionNumber(output: string): string | undefined {
  const match = GIT_VERSION_NUMBER_PATTERN.exec(output);
  if (match === null) {
    return undefined;
  }
  return match[1];
}

export const GIT_OPERATIONS = ['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'] as const;

export type GitOperation = (typeof GIT_OPERATIONS)[number];

export const GIT_OPERATION_MARKERS: ReadonlyArray<{
  readonly operation: GitOperation;
  readonly marker: string;
}> = [
  { operation: 'merge', marker: 'MERGE_HEAD' },
  { operation: 'rebase', marker: 'rebase-merge' },
  { operation: 'rebase', marker: 'rebase-apply' },
  { operation: 'cherry-pick', marker: 'CHERRY_PICK_HEAD' },
  { operation: 'revert', marker: 'REVERT_HEAD' },
  { operation: 'bisect', marker: 'BISECT_LOG' },
];

export const RUN_STORAGE_DIRECTORY_NAME = '.agent' as const;
