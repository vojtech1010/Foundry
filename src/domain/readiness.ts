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

export const GITHUB_HOST = 'github.com' as const;

export interface GitHubRepositoryReference {
  readonly owner: string;
  readonly name: string;
}

function repositoryFromSegments(
  host: string | undefined,
  path: string | undefined,
): GitHubRepositoryReference | undefined {
  if (host === undefined || path === undefined) {
    return undefined;
  }
  if (host.toLowerCase() !== GITHUB_HOST) {
    return undefined;
  }
  const segments = path.replaceAll(/^\/+|\/+$/gu, '').split('/');
  const owner = segments[0];
  const rawName = segments[1];
  if (segments.length !== 2 || owner === undefined || rawName === undefined) {
    return undefined;
  }
  const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
  if (owner.length === 0 || name.length === 0) {
    return undefined;
  }
  return { owner, name };
}

export function parseGitHubRepositoryRemote(remote: string): GitHubRepositoryReference | undefined {
  const trimmed = remote.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!trimmed.includes('://')) {
    const separator = trimmed.indexOf(':');
    if (separator > 0) {
      const authority = trimmed.slice(0, separator);
      const path = trimmed.slice(separator + 1);
      const host = authority.includes('@')
        ? authority.slice(authority.indexOf('@') + 1)
        : authority;
      return repositoryFromSegments(host, path);
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  return repositoryFromSegments(parsed.hostname, parsed.pathname);
}

export function renderGitHubRepository(reference: GitHubRepositoryReference): string {
  return `${reference.owner}/${reference.name}`;
}

export function githubRepositoriesMatch(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export const PUBLICATION_CAPABILITIES = [
  'push',
  'pull_request',
  'issue_comment_read',
  'collaborator_permission',
] as const;

export type PublicationCapability = (typeof PUBLICATION_CAPABILITIES)[number];

export type PublicationCapabilityState = 'granted' | 'denied' | 'unknown';

export type PublicationRepositoryScope = 'repository' | 'broad' | 'unknown';

export const BROAD_GITHUB_TOKEN_SCOPES = [
  'repo',
  'public_repo',
  'repo:status',
  'repo_deployment',
  'delete_repo',
  'workflow',
  'write:packages',
  'read:packages',
  'delete:packages',
  'admin:org',
  'write:org',
  'admin:public_key',
  'write:public_key',
  'admin:repo_hook',
  'write:repo_hook',
  'admin:gpg_key',
  'write:gpg_key',
  'admin:ssh_signing_key',
  'write:ssh_signing_key',
  'manage_runners:org',
  'admin:enterprise',
  'manage_billing:enterprise',
] as const;

export function isBroadGitHubTokenScope(scope: string): boolean {
  return BROAD_GITHUB_TOKEN_SCOPES.some((broad) => broad === scope);
}

export function publicationRepositoryScope(
  tokenScopes: ReadonlyArray<string> | null,
): PublicationRepositoryScope {
  if (tokenScopes === null) {
    return 'repository';
  }
  return tokenScopes.some((scope) => isBroadGitHubTokenScope(scope)) ? 'broad' : 'repository';
}
