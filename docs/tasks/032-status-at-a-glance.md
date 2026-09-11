# 032 — See current progress at a glance

## Requirement

An operator can ask for status without pausing an active run. Status reports
the run ID, named state, active role and attempt, elapsed time, last event,
branch and commit when known, retry and correction counts, and bounded
statistics. Missing usage is unknown, not zero.

## Observable outcome

- Status is read-only and does not approve or advance work.
- Status is not proof that an artifact is valid or that a pull request exists.
- Unavailable token or cost figures stay unknown; they are not shown as zero
  spend.
- Local failed commands inside one Coder session are not counted as extra
  Foundry role retries.

## Not in this task

Deep inspection of artifacts, or the final handoff document.

## Depends on

[010](010-status-from-history.md), [007](007-named-progress.md)

## Spec

- [Status](../features/inspection-and-reporting.md#status)
- [Statistics and retained information](../features/inspection-and-reporting.md#statistics-and-retained-information)

## Size guess

~6 files / ~300 lines
