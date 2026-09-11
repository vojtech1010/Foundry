# 033 — Inspect accepted evidence, failures, and open decisions

## Requirement

An operator can inspect a run to see accepted plan, implementation, checks,
Tester, and Reviewer artifacts; failed attempts; validation errors; findings;
correction history; decision escalation; publication state; and incomplete
journals. Inspection does not pause work and is not a stage-control surface.

## Observable outcome

- Inspection links a criterion from the accepted plan through the result
  commit to its checks and Reviewer assessment.
- Empty summary lists are not treated as proof that nothing happened.
- When the run is waiting on a person, inspection shows the question, options,
  recommendation, unresolved issues, commits, draft URL, exact commands, and
  whether a decision comment has been accepted.
- Misleading or duplicate captures can be identified; a filename is not proof
  of content.

## Not in this task

Writing the canonical handoff, or exporting a diagnostic bundle.

## Depends on

[032](032-status-at-a-glance.md), [026](026-reviewer-outcomes.md)

## Spec

- [Inspect artifacts and findings](../features/inspection-and-reporting.md#inspect-artifacts-and-findings)
- [Human-decision report](../features/inspection-and-reporting.md#human-decision-report)

## Size guess

~10 files / ~450 lines
