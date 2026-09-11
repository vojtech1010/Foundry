# 027 — Actionable findings return to Coder as a bounded correction

## Requirement

When Reviewer asks for changes, or when project checks fail with work still
possible, Foundry sends Coder a new correction. Every correction creates a
new commit. Exhausting the correction budget does not silently approve the
result. Retiring checks and observations from an older commit is required
here, and is fully specified as a general rule in the later head-advance
task.

## Observable outcome

- Foundry owns finding records. Reviewer may explain several issues in one
  written report rather than filling a form per issue.
- Failed project commands become separate Foundry-owned findings.
- Informational notes stay distinct from blocking findings; an unmet required
  criterion cannot be hidden as a note.
- After a new commit, checks, live testing when required, and Reviewer all
  run again.
- With a reviewable commit and no remaining automatic correction, Reviewer
  must choose a genuine human decision or block — not another automatic
  correction.

## Not in this task

Publishing a pull request, repairing a malformed envelope, or covering every
kind of accepted-head change.

## Depends on

[026](026-reviewer-outcomes.md), [019](019-coder-commits-the-change.md)

## Spec

- [Corrections](../features/running-work.md#corrections)
- [Findings and automatic correction](../features/quality-and-decisions.md#findings-and-automatic-correction)

## Size guess

~10 files / ~500 lines
