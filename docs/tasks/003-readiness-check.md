# 003 — Check that a project is ready

## Requirement

Before a real run, an operator can ask Foundry whether the host, configuration,
storage, and target repository identity look safe. A live run is not created.
Missing tools, an unclean repository, or a document that cannot be used fail
with a clear report.

## Observable outcome

- `doctor` checks supported tooling, the configuration document, run storage,
  and the target repository identity.
- “Clean” means no leftover tracked or untracked work outside ignored paths,
  and no merge, rebase, or similar Git operation in progress.
- The check does not switch or update the operator's checked-out branch.
- Role-host and GitHub publication checks may still be deferred; this task
  covers the rest of preflight.

## Not in this task

Previewing resolved paths, running project commands, or talking to GitHub.

## Depends on

[002](002-project-configuration.md)

## Spec

- [Validate before work](../features/project-setup.md#validate-before-work)
- [Prerequisites](../features/project-setup.md#prerequisites)

## Size guess

~10 files / ~450 lines
