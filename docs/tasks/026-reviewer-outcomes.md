# 026 — Reviewer chooses from a small set of outcomes

## Requirement

Reviewer reads the accepted plan, the Git-derived change, project checks,
optional Tester observations, findings, and correction history. It chooses
approved, changes requested, another observation, a genuine product decision,
or blocked. Ordinary approval finishes the run locally. Reviewer cannot
approve failed required checks or missing required live evidence.

## Observable outcome

- `approved` completes the run without asking a person and without opening a
  pull request.
- `changes_requested` is allowed only while a correction round remains.
- `retest_requested` is allowed only while a Tester retry remains and does
  not change code.
- A product-or-risk choice uses `human_decision_required` and must include
  the question and labeled options.
- Operational or integrity problems use `blocked`, not a speculative pull
  request.

## Not in this task

Opening the draft pull request, or applying a human command on it.

## Depends on

[021](021-project-checks-on-commit.md), [025](025-tester-observes-without-mutation.md)

## Spec

- [Reviewer outcomes](../features/quality-and-decisions.md#reviewer-outcomes)
- [Completion rule](../features/quality-and-decisions.md#completion-rule)

## Size guess

~10 files / ~450 lines
