# 054 — Bundle the role host; drop the external adapter from configuration

## Requirement

Foundry moves the external role-host adapter into the application and ships it
as a bundled host instead of spawning an externally configured one. The
`roleHarness` block (`protocol`, `command`, `environmentAllowlist`) leaves the
configuration document: per-role harness and model selection (see 053) is the
only harness-related configuration, and launch details stay hardcoded in
Foundry per harness and platform.

## Observable outcome

- A configuration without `roleHarness` is accepted; one containing it
  is rejected as an unknown field under the closed-document rule.
- Role-host operations use the bundled implementation and no longer spawn a
  configured external adapter process.
- `doctor` verifies the bundled host directly: required harness
  binaries are present, listed models resolve, and every role plus
  capability profile is covered without spawning an external adapter.
- `init --dry-run` reports the resolved per-role routing from the
  bundled host, unchanged on Linux and Windows apart from executable
  resolution.
- Runs, resume, and violation handling behave as with an external host;
  `runtimeIdentity` provenance is unchanged.
- Provider credentials are read by the Foundry process itself; exactly
  which environment names are read is documented, and values still never
  reach configuration, prompts, or logs.
- The accepted costs are explicit: Foundry releases now track vendor CLI
  changes, and the credential and workflow trust domains share one
  process.

## Not in this task

Per-stage approval modes, Tester data-mutation authority, or changing
the Architect/Coder/Tester/Reviewer envelopes and routing.

## Depends on

[048](048-stand-in-role-host.md), [053](053-per-role-harness-models.md)

## Spec

- [Configuration shape](../features/project-setup.md#configuration-shape)
- [Role-host protocol](../features/protocol-contracts.md#role-host-protocol)
- [One operating model](../features/product-and-modes.md#one-operating-model)

## Size guess

~12 files / ~500 lines; split the vendor-harness coverage if it heads
past that.
