# 038 — Delete old finished runs only with explicit confirmation

## Requirement

Retention cleanup is never background work. An operator lists eligible
finished runs, then confirms deletion of one run by repeating its ID.
Nonterminal runs are never eligible. The task branch and canonical handoff
are kept.

## Observable outcome

- Eligibility uses the terminal completion, failure, or abandonment time and
  the configured retention window.
- Cleanup checks state, history, workers, workspaces, branches, and ownership
  before each deletion.
- Partial success is allowed; the operator lists again after a failure.
- Operators are told not to delete run storage by hand.

## Not in this task

Automatic end-of-run process disposal, or diagnostic bundles.

## Depends on

[037](037-cleanup-keeps-the-result.md)

## Spec

- [Retention cleanup](../features/inspection-and-reporting.md#retention-cleanup)
- [CLI result contract](../features/protocol-contracts.md#cli-result-contract)

## Size guess

~8 files / ~400 lines
