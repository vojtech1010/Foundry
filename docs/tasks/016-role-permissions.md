# 016 — Each role may only do what its job allows

## Requirement

Architect, Tester, and Reviewer are read-only against the project. Only Coder
may change production files, and only inside the run-owned workspace. Tester
may reach only the prepared application origin. Other roles have no
agent-visible network. Secrets are forwarded only as named environment
variables and are never written into configuration, prompts, or logs.

## Observable outcome

- Architect and Reviewer cannot write project files.
- Tester cannot create, change, or delete application data, and cannot reach
  arbitrary network destinations.
- Coder cannot use the application network.
- Foundry also compares Git and owned resources before and after a read-only
  turn as a second check, but that check does not replace host enforcement.
- A permission violation is recorded and stops that attempt; it is not
  treated as a successful result.

## Not in this task

Preparing the application, or reviewing a change.

## Depends on

[015](015-capable-role-host.md)

## Spec

- [One operating model](../features/product-and-modes.md#one-operating-model)
- [Role-host protocol](../features/protocol-contracts.md#role-host-protocol)

## Size guess

~10 files / ~450 lines
