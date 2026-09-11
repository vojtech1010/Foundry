# 002 — One closed project configuration

## Requirement

A project is described in one configuration document. Unknown fields are
rejected. The document names the target repository, source remote and branch,
task-branch naming, one role harness, timeouts, retry budgets, limits,
project commands, optional application runtime, optional decision publication,
and artifact bounds. There is no setting for manual, pilot, shadow, or
adoption operation.

## Observable outcome

- A valid document is accepted; extra or mistyped fields fail before work
  starts.
- Runtime and publication may be omitted. When present, they are complete.
- Decision publication, when present, is always a draft and never lets
  maintainers change the branch from GitHub.
- Relative paths are understood from the configuration file's directory.
- The five verification commands are required; bootstrap may be omitted.

## Not in this task

Talking to GitHub, launching a role host, or running project commands.

## Depends on

[001](001-public-command-surface.md)

## Spec

- [Configuration shape](../features/project-setup.md#configuration-shape)

## Size guess

~8 files / ~450 lines
