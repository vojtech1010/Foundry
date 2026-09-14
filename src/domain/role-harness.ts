/**
 * Shared role/harness vocabulary for configuration and the role host.
 *
 * This is the single authoritative home for the per-role harness contract:
 * the protocol name, the harness names, the role names, the per-role
 * selections, and the exact bundled credential names. Both
 * `project-configuration.ts` and `role-host.ts` consume this module and
 * re-export its vocabulary for their existing importers, so neither defines
 * what the other needs and no domain import cycle remains. The module has no
 * domain imports by construction; keep it that way.
 */

export const ROLE_HARNESS_PROTOCOL = 'foundry-role-host-v1' as const;

/**
 * Harnesses Foundry knows how to launch. The configuration names one per
 * role; the exact launch argv and the accepted model catalog per harness are
 * hardcoded in the role-host adapter (see `src/platform/role-host.ts`), never
 * carried in configuration. The legacy `roleHarness` block left the
 * configuration document in task 054: per-role selection is the only
 * harness-related configuration.
 */
export const ROLE_HARNESS_NAMES = ['codex', 'opencode'] as const;

export type RoleHarnessName = (typeof ROLE_HARNESS_NAMES)[number];

export const ROLE_HOST_ROLES = ['architect', 'coder', 'lead_coder', 'tester', 'reviewer'] as const;

export type RoleHostRole = (typeof ROLE_HOST_ROLES)[number];

/**
 * The exact provider credential names the Foundry process reads from its own
 * environment and forwards to bundled harnesses at launch. Both shipped
 * harnesses serve OpenAI models, so the set is one name; it is documented in
 * `docs/features/protocol-contracts.md`, and any addition is a deliberate
 * catalog change, never per-project configuration. Credential values never
 * reach configuration, prompts, or logs.
 */
export const BUNDLED_CREDENTIAL_ENVIRONMENT_NAMES: ReadonlyArray<string> = ['OPENAI_API_KEY'];

/**
 * The per-role harness and model selection carried in configuration. `model`
 * is stored trimmed and must be non-empty; whether the trimmed value names a
 * real model is decided by the harness adapter against its own catalog at
 * launch time, never by inventing a substitute.
 */
export interface RoleHarnessSelection {
  readonly harness: RoleHarnessName;
  readonly model: string;
}

/** Every role names its harness and model; missing roles fail closed. */
export type RoleHarnessSelections = {
  readonly [role in RoleHostRole]: RoleHarnessSelection;
};
