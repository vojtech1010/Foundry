# 015 — Refuse a live run if the role host cannot keep sessions or permissions

## Requirement

Before source provisioning for a live run, Foundry asks the configured host
what it can do. A host that cannot resume sessions or cannot enforce the
required role permission profiles is rejected.

## Observable outcome

- `doctor` and a live `run` both fail clearly when the host cannot attest
  resumable sessions and the required profiles.
- The host reports which roles it can run and which permission profiles it
  enforces.
- Model choice stays with the host; Foundry records what was actually used
  as provenance without changing the workflow.

## Not in this task

The conversations themselves, or GitHub publication checks.

## Depends on

[003](003-readiness-check.md), [014](014-role-conversations.md)

## Spec

- [Validate before work](../features/project-setup.md#validate-before-work)
- [Role-host protocol](../features/protocol-contracts.md#role-host-protocol)

## Size guess

~8 files / ~350 lines
