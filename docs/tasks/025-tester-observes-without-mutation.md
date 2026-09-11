# 025 — Tester may observe but must not change application data

## Requirement

Tester looks at the prepared application and writes ordinary Markdown
observations. Its machine outcomes are observed, needs another try, or
blocked — never passed or failed. Plans cannot grant permission to create,
change, or delete application records. Screenshots are optional evidence, not
a required gallery.

## Observable outcome

- Tester receives only the prepared origin and read-only access.
- If meaningful live proof needs data changes, the plan prefers the project's
  own isolated tests, or records the limitation for Reviewer.
- Another Tester try repeats against the same commit and does not send work
  back to Coder.
- Missing required live evidence cannot be approved.

## Not in this task

Reviewer choosing among outcomes, or Foundry starting the application.

## Depends on

[024](024-foundry-owns-the-application.md), [016](016-role-permissions.md)

## Spec

- [Tester boundary](../features/quality-and-decisions.md#tester-boundary)
- [Runtime testing boundary](../features/running-work.md#runtime-testing-boundary)

## Size guess

~10 files / ~450 lines
