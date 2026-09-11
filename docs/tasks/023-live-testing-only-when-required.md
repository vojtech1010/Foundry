# 023 — Live application testing happens only when the plan requires it

## Requirement

If the accepted plan says live testing is not required, Foundry records an
explicit skip and goes to Reviewer after project checks. It does not invent a
passing Tester result. If the plan requires live evidence, that stage cannot be
skipped or approved away.

## Observable outcome

- A skip is recorded with its reason and is visible later as a skip, not a
  pass.
- Log filenames do not prove that Tester ran.
- Reviewer still sees the project-check report.
- A required live stage without a usable application profile cannot be
  silently skipped.

## Not in this task

Starting the application, or Tester's read-only observations.

## Depends on

[017](017-bounded-plan.md), [021](021-project-checks-on-commit.md)

## Spec

- [Plan-controlled validation](../features/running-work.md#plan-controlled-validation)

## Size guess

~6 files / ~250 lines
