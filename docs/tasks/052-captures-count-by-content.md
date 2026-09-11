# 052 — Captures count by content, not by filename or caption

## Requirement

Optional screenshots, logs, and other captures are evidence only when their
content can be identified. Two files with the same content are one
observation even if their names or captions differ. Reviewer must discount
misleading labels and say what was excluded. Approval may still rest on other
independent evidence the plan allows.

## Observable outcome

- Inspection and the handoff can tell a hashed capture from a name-only
  claim.
- A required criterion is unproven if its only support is a mislabeled or
  duplicated capture and no independent evidence remains.
- Missing a screenshot gallery does not fail an otherwise proven result.
- Pre-existing copy or UX notes may stay informational; they do not hide an
  unmet required criterion.

## Not in this task

Granting Tester permission to change application data, or requiring named
visual variants.

## Depends on

[025](025-tester-observes-without-mutation.md), [033](033-inspect-evidence.md),
[026](026-reviewer-outcomes.md)

## Spec

- [Evidence integrity and completeness](../features/inspection-and-reporting.md#evidence-integrity-and-completeness)
- [Runtime identity, criterion evidence, and observations](../features/run-history-evidence.md#runtime-identity-criterion-evidence-and-observations)

## Size guess

~6 files / ~300 lines
