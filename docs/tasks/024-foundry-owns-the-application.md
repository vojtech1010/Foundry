# 024 — Foundry prepares and stops the application

## Requirement

When live testing is required, Foundry owns reset, build, start, readiness,
stop, and process cleanup. Tester receives a prepared application. Preparing
the application does not wipe data. The only supported data policy is to
preserve existing data.

## Observable outcome

- Start is the long-running process; Foundry owns its process tree before it
  asks whether the application is ready.
- Readiness is polled until it succeeds or the readiness budget expires.
- Stop is a polite request, then Foundry stops only the recorded owned
  processes after the grace period.
- Runtime records identify the repository, accepted commit, application,
  lifecycle times, and whether data was preserved.
- A project without an application profile omits this stage rather than
  faking it.

## Not in this task

Tester's observations, or granting Tester write access.

## Depends on

[023](023-live-testing-only-when-required.md), [022](022-dirtying-command-is-a-violation.md)

## Spec

- [Project commands and runtime](../features/project-setup.md#project-commands-and-runtime)
- [Target runtime profile](../features/protocol-contracts.md#target-runtime-profile)

## Size guess

~12 files / ~500 lines
