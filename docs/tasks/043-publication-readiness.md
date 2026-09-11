# 043 — When publication is enabled, check readiness before a live run

## Requirement

A project may run without GitHub publication. If publication is enabled,
Foundry verifies before a live run that the source remote is GitHub, matches
the publication remote, and that credentials can push without force, create
or update a draft pull request, read issue comments, and look up collaborator
permission. The credential must be limited to the configured repository.

## Observable outcome

- `doctor` reports publication readiness when publication is configured.
- Task branch names that would collide with protected branches fail preflight.
- Missing GitHub eligibility does not block ordinary approved runs.
- A later human-decision outcome without an eligible channel blocks rather
  than inventing another way to ask a person.

## Not in this task

Creating the draft pull request, or applying a human command.

## Depends on

[003](003-readiness-check.md), [002](002-project-configuration.md)

## Spec

- [GitHub escalation readiness](../features/project-setup.md#github-escalation-readiness)
- [Publication outcomes](../features/results-and-publication.md#publication-outcomes)

## Size guess

~8 files / ~350 lines
