# 008 — Work advances only along allowed routes

## Requirement

A run may change state only when the required fact for that jump is true.
Retries and envelope repairs stay in the current state and record a new
attempt. Cleanup progress is separate and never rewrites an accepted result.

## Observable outcome

- Illegal jumps are refused and explained.
- Approval cannot follow failed required checks or missing required live
  evidence.
- `completed` and `completed_no_change` are terminal successes.
- `failed` and `abandoned` are terminal; `blocked` can resume after its
  prerequisite is fixed.
- A no-change candidate cannot become a human-decision pull request.

## Not in this task

Performing the work inside each state, or recovering from crashes.

## Depends on

[007](007-named-progress.md)

## Spec

- [Legal transition routes](../features/running-work.md#legal-transition-routes)

## Size guess

~8 files / ~400 lines
