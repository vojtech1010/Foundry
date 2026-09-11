# 010 — Current status comes from that history

## Requirement

When a run is opened or resumed, Foundry reads the full history, checks it,
and rebuilds current status from it. A disagreeing snapshot is replaced. The
snapshot is never used to push the run forward.

## Observable outcome

- After a restart, status matches the history, not leftover files.
- A corrupted or incomplete history does not get a guessed repair.
- Inspection can point at the history when a summary looks empty or wrong.

## Not in this task

Operator-facing `status`/`inspect` commands, or crash recovery of role work.

## Depends on

[009](009-trustworthy-run-history.md)

## Spec

- [Durable-record minimum](../features/protocol-contracts.md#durable-record-minimum)
- [Evidence integrity and completeness](../features/inspection-and-reporting.md#evidence-integrity-and-completeness)

## Size guess

~8 files / ~400 lines
