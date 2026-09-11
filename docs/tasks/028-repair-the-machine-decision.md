# 028 — Repair a malformed machine decision without rewriting the report

## Requirement

If a role finishes its written report but the small machine envelope is
invalid, Foundry may ask once in the same session to fix only that envelope.
The written report stays unchanged. A repair cannot rewrite project files,
tests, Git, or application data, and cannot turn missing evidence into a
pass.

## Observable outcome

- Role retries, envelope repairs, and implementation corrections remain
  separate budgets and separate records.
- Rejected envelopes and validation errors are kept even if a later attempt
  succeeds.
- A repair that only drops unknown fields can still fail meaning checks and
  need another recorded attempt.
- Empty reports, mismatched sessions, or ambiguous sends are not accepted as
  success.

## Not in this task

The first successful Architect/Coder/Reviewer happy path, or GitHub
publication.

## Depends on

[014](014-role-conversations.md), [017](017-bounded-plan.md)

## Spec

- [Control repair versus retest](../features/quality-and-decisions.md#control-repair-versus-retest)
- [Role recovery](../features/recovery.md#role-recovery)

## Size guess

~8 files / ~400 lines
