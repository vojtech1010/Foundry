# ADR-0005: Durable Events, CAS Revisions, Atomic Persistence, Replay Safety

- Status: Accepted
- Date: 2026-09-08
- Relates to: `docs/features/recovery.md`,
  `docs/features/inspection-and-reporting.md`

## Context

Runs are interrupted: processes die, leases expire, pushes half-finish.
If state is a mutable JSON blob overwritten in place, recovery cannot
tell what happened and will duplicate role prompts, commits, or PRs.

## Decision

The append-only durable event log is the source of truth for a run:

- Every mutation carries an expected monotonic revision; persistence is
  compare-and-swap. A stale writer re-reads and reconciles instead of
  overwriting.
- Writes are atomic (temporary file plus rename; never partial
  overwrite). `.agent/runs/` is never hand-edited to make a run
  advance; the handoff is a report, not state.
- Side effects use idempotent journals with pre/post checkpoints: role
  submission (pre-submit baseline plus submission state), task-branch
  push, and draft-PR create-or-reuse. Recovery resumes from the
  checkpoint and reattaches to the owned operation; it never resubmits a
  prompt, recommit, or republication blindly.
- Uncertain ownership or ambiguous submission evidence stops as
  `blocked`, preserving evidence for inspection. `human_recovery` is a
  recovery disposition from `docs/features/recovery.md` — the need for
  a person to investigate integrity — not a persisted workflow state.

## Consequences

- Crash recovery is honest — accept, continue waiting, retry when
  proven safe, block, or stop for human recovery — using the recovery
  dispositions defined in `docs/features/recovery.md`.
- Storage code is concentrated behind one persistence seam owned by the
  run-lifecycle slice, which must handle revision conflicts and atomic
  writes correctly once.
- Evidence bounds and redaction apply at write time so bundles stay
  bounded.

## Rejected alternatives

- Last-writer-wins JSON overwrite: loses concurrent updates and hides
  interrupted side effects.
- File-presence checks as completion signals: cannot distinguish
  interrupted from accepted work.
- Non-journaled push / PR calls retried by re-running the command: risks
  duplicate branches and PRs.

## Enforcement / verification

- Concurrency tests assert CAS conflicts reconcile without lost events.
- Crash-replay tests kill mid-submission, mid-push, and mid-publication
  and assert exactly-once resumption semantics.
- Persistence tests assert atomic writes (no torn files) and reject
  direct `.agent/runs` mutation paths outside the owned seam.
