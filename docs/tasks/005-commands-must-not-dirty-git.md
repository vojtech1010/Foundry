# 005 — Project commands must not rewrite the repository

## Requirement

An operator can ask Foundry to run the configured project commands in order
and fail if any of them change tracked Git state. This is a readiness check,
not a run.

## Observable outcome

- `profile-check` runs bootstrap (when configured) and the verification
  commands in the documented order.
- A command that changes tracked files fails the check.
- Commands run directly, not through a shell, in a location that stays inside
  the target repository.

## Not in this task

Recording a run, reconstructing a dirty worktree during a live run, or
starting an application.

## Depends on

[003](003-readiness-check.md)

## Spec

- [Validate before work](../features/project-setup.md#validate-before-work)
- [Project commands and runtime](../features/project-setup.md#project-commands-and-runtime)

## Size guess

~8 files / ~400 lines
