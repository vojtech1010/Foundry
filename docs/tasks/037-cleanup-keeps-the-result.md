# 037 — Dispose owned resources without erasing the result

## Requirement

When a run finishes, Foundry releases owned application processes, role
sessions, and workspaces while keeping the result and bounded evidence.
Cleanup problems are reported. They do not undo an accepted result or cause
implementation to run again.

## Observable outcome

- Status and inspection distinguish result completion from cleanup completion.
- A completed run may still show pending or failed shutdown, uncertain host
  ownership, or a workspace-removal warning.
- Disposing a process or workspace does not mean the task branch was deleted.
- End-of-run disposal is automatic; retention deletion is not.

## Not in this task

Confirmed retention cleanup of old runs, or abandonment.

## Depends on

[024](024-foundry-owns-the-application.md), [012](012-run-owned-workspace.md)

## Spec

- [Abandonment and cleanup](../features/recovery.md#abandonment-and-cleanup)
- [Retention cleanup](../features/inspection-and-reporting.md#retention-cleanup)

## Size guess

~10 files / ~450 lines
