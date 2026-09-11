# 044 — Linux and Windows operators get the same workflow and safety

## Requirement

Foundry supports Linux and Windows. Path handling, command launching, process
cleanup, locking, and crash recovery preserve the same autonomous workflow,
role permissions, Git safety, and recovery behavior on both systems. A feature
is not done until those observable checks pass on both.

## Observable outcome

- Commands are launched as argument lists, never through a shell.
- Windows path and junction rules are honored without loosening containment.
- Owned process cleanup stops the recorded process tree rather than matching
  by executable name.
- Role-host permission, path-escape, durable-history, lock-recovery,
  temporary-repository, and interrupt/resume checks exist for both platforms.

## Not in this task

Inventing a second operating model for Windows, or weakening Git safety.

## Depends on

[014](014-role-conversations.md), [011](011-one-repository-owner.md),
[035](035-resume-without-repeating-work.md)

## Spec

- [Supported host platforms](../features/product-and-modes.md#supported-host-platforms)
- [Linux and Windows parity](../features/protocol-contracts.md#linux-and-windows-parity)

## Size guess

~10 files / ~400 lines
