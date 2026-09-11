# 048 — A stand-in role host can walk the full workflow

## Requirement

A developer or test operator can go through Architect → Coder → checks →
optional Tester → Reviewer using a stand-in role host. The stand-in obeys the
same permissions, publication rules, and machine envelopes as a live host. It
does not create a second product mode.

## Observable outcome

- A sequential request can be driven to a terminal result without a live
  vendor agent.
- Read-only roles still cannot change production files; Coder still commits
  only in the run-owned workspace.
- Switching to a live host does not change when a pull request is opened or
  who may write files.
- Lost sessions, invalid envelopes, and blocked outcomes still behave as in
  a live run.

## Not in this task

Building a production vendor adapter, or weakening Git safety for tests.

## Depends on

[014](014-role-conversations.md), [016](016-role-permissions.md),
[045](045-run-owns-first-pass.md), [046](046-automatic-routing-after-review.md)

## Spec

- [One operating model](../features/product-and-modes.md#one-operating-model)
- [Role-host protocol](../features/protocol-contracts.md#role-host-protocol)

## Size guess

~10 files / ~450 lines
