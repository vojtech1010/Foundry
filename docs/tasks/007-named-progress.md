# 007 — Named progress a person can understand

## Requirement

Every run has one named workflow state. Operators and later recovery use the
same names. Files sitting in run storage never count as success by themselves.

## Observable outcome

- Active work uses names such as planning, coding, verifying, testing,
  reviewing, and correcting.
- Waiting on a person uses `human_decision_required`. Publishing a decision
  uses `publishing`.
- Terminal names include completed, completed with no change, abandoned,
  blocked, failed, and publish-failed.
- Status language matches those names and does not invent extra product modes.

## Not in this task

Enforcing which jumps are legal, or driving a real role.

## Depends on

[006](006-request-and-run-identity.md)

## Spec

- [Important states](../features/running-work.md#important-states)
- [One operating model](../features/product-and-modes.md#one-operating-model)

## Size guess

~6 files / ~300 lines
