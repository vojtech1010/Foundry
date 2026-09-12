export const PUBLIC_COMMANDS = [
  'run',
  'resume',
  'status',
  'inspect',
  'doctor',
  'init',
  'profile-check',
  'diagnostic-bundle',
  'cleanup',
] as const;

export type PublicCommand = (typeof PUBLIC_COMMANDS)[number];

export const NON_PRODUCT_COMMANDS = ['approve', 'reject', 'code', 'test', 'review'] as const;

export type NonProductCommand = (typeof NON_PRODUCT_COMMANDS)[number];

export function isPublicCommand(value: string): value is PublicCommand {
  return PUBLIC_COMMANDS.some((command) => command === value);
}

export function isNonProductCommand(value: string): value is NonProductCommand {
  return NON_PRODUCT_COMMANDS.some((command) => command === value);
}

export const REPORT_SCHEMA_VERSION = 1 as const;

export const INVALID_INVOCATION_KIND = 'invalid_invocation' as const;

export const REPORT_FAILURE_KINDS = [
  INVALID_INVOCATION_KIND,
  'blocked',
  'failed',
  'publish_failed',
] as const;

export type ReportFailureKind = (typeof REPORT_FAILURE_KINDS)[number];

export const NOT_AVAILABLE = 'not_available' as const;

export type ReportOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: ReportFailureKind };

export const EXIT_CODES = {
  reported: 0,
  operationFailed: 1,
  invalidInvocation: 2,
} as const;

export function exitCodeForOutcome(outcome: ReportOutcome): number {
  if (outcome.ok) {
    return EXIT_CODES.reported;
  }
  return outcome.kind === INVALID_INVOCATION_KIND
    ? EXIT_CODES.invalidInvocation
    : EXIT_CODES.operationFailed;
}

export const INTERRUPT_EXIT_CODES = {
  signalled: 130,
  windowsControlC: 0xc000013a,
} as const;

export function interruptExitCodeFor(platform: string): number {
  return platform === 'win32'
    ? INTERRUPT_EXIT_CODES.windowsControlC
    : INTERRUPT_EXIT_CODES.signalled;
}

export interface PublicCommandInvocation {
  readonly command: PublicCommand;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly config?: string | undefined;
  readonly request?: string | undefined;
  readonly cwd?: string | undefined;
}
