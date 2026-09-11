# 004 — Preview where a run would work, without changing anything

## Requirement

An operator can ask Foundry to show the resolved source, branch, workspace,
role harness, and artifact locations for a task ID. Nothing in the target
repository is created or changed.

## Observable outcome

- `init --dry-run` prints the locations a later run would use.
- The command fails on the same configuration and identity problems `doctor`
  would catch for this preview.
- Repeating the command leaves Git status unchanged.

## Not in this task

Creating worktrees, fetching source, or starting role work.

## Depends on

[003](003-readiness-check.md)

## Spec

- [Validate before work](../features/project-setup.md#validate-before-work)

## Size guess

~6 files / ~250 lines
