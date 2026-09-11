# 047 — Each role sees previous reports and Foundry facts, intact

## Requirement

Every role receives the operator request, frozen guidance, and the complete
accepted written reports from roles before it. Foundry also attaches its own
Git, check, runtime, retry, and correction facts. Those written reports are
passed through, not summarized into a new agent-authored form. Size pressure
uses bounded attachments, never silent cutting of mandatory text.

## Observable outcome

- Architect sees the request and guidance, not a live reread of the repo's
  instruction files.
- Coder sees the accepted plan narrative and Foundry's routing facts.
- Tester sees the plan, the recorded commit, the check report, and the
  prepared application origin — and does not rerun the same project checks.
- Reviewer sees plan, Git-derived change, check report, Tester observations
  or an explicit skip, findings, and correction history.
- A role never has to reproduce Foundry's run history in order to do its job.

## Not in this task

Choosing Reviewer outcomes, or starting the application.

## Depends on

[013](013-frozen-guidance.md), [017](017-bounded-plan.md),
[021](021-project-checks-on-commit.md), [025](025-tester-observes-without-mutation.md),
[026](026-reviewer-outcomes.md)

## Spec

- [Free-form handoffs](../features/protocol-contracts.md#free-form-handoffs-with-a-narrow-control-envelope)
- [Verification evidence](../features/quality-and-decisions.md#verification-evidence)

## Size guess

~8 files / ~400 lines
