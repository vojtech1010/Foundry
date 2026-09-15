# 053 — Per-role harness and model selection in configuration

## Requirement

The configuration document names one harness and model per role
(`architect`, `coder`, `lead_coder`, `tester`, `reviewer`). The exact
command-line used to launch each harness is hardcoded in the role-host
adapter per harness and runtime, never carried in configuration. There
is still one operating model and one role-host protocol.

## Observable outcome

- A valid document is accepted only when every role names a supported
  harness and a non-empty model string.
- Unknown harnesses, missing roles, or extra fields fail before work
  starts, under the same closed-document rule as the rest of the
  configuration.
- `doctor` and `init --dry-run` report the resolved per-role routing
  (harness and model) without launching anything.
- A live adapter rejects an unknown model against its own catalog and
  fails closed; Foundry never invents a substitute model.
- `runtimeIdentity` keeps recording the actually assigned
  `{ adapterVersion, provider, model, toolProfile }` per session as
  provenance.
- The same document resolves the same routing on Linux and Windows;
  only executable resolution follows existing platform rules.

## Not in this task

Building vendor adapters, changing the role-host operations, per-stage
approval modes, or Tester data-mutation authority.

## Depends on

[002](002-project-configuration.md), [014](014-role-conversations.md),
[015](015-capable-role-host.md)

## Spec

- [Configuration shape](../features/project-setup.md#configuration-shape)
- [Role-host protocol](../features/protocol-contracts.md#role-host-protocol)

## Size guess

~8 files / ~400 lines
