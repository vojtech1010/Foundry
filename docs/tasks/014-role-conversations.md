# 014 — Role work happens in a resumable conversation

## Requirement

Foundry talks to roles through one host program. It creates a session, records
who owns it, sends one turn, watches until that turn settles, and can stop the
session. After a send has begun, recovery watches the same session instead of
sending the original prompt again.

## Observable outcome

- The host is launched directly, not through a shell.
- Create, send, watch, and stop each have a closed request and a closed
  answer.
- A send that is retried with the same identity does not start a second turn.
- Watching never starts new work.
- A lost or mismatched session is an operational failure, not a successful
  plan or review.

## Not in this task

Checking host capabilities, enforcing filesystem permissions, or interpreting
Architect/Coder outcomes.

## Depends on

[012](012-run-owned-workspace.md)

## Spec

- [Role-host protocol](../features/protocol-contracts.md#role-host-protocol)
- [Role recovery](../features/recovery.md#role-recovery)

## Size guess

~12 files / ~500 lines
