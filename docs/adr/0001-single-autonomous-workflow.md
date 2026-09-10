# ADR-0001: Single Autonomous Workflow and Explicit State Machine

- Status: Accepted
- Date: 2026-09-08
- Relates to: `docs/features/product-and-modes.md`,
  `docs/features/running-work.md`

## Context

Foundry turns a written request into a validated, reviewable change with
minimal human interruption. Without a firm rule, stage approvals, pilot
modes, shadow runs, and adoption flags accumulate, and agents start
inferring completion from file presence or role termination instead of
validated transitions.

## Decision

There is exactly one operating model: autonomous execution through
Architect → Coder → deterministic checks → optional Tester → Reviewer.

- Workflow state is an explicit typed union, including `planning`,
  `coding`, `verifying`, `testing`, `reviewing`, `correcting`,
  `publishing`, `human_decision_required`, `completed`,
  `completed_no_change`, `blocked`, `failed`, and `publish_failed`.
- Every transition is a validated event against the durable run record.
  File existence, role termination, or log output never implies success.
- There are no manual, pilot, shadow, or adoption modes: no mode flags,
  mode configs, or per-stage `approve` / `reject` / `code` / `test` /
  `review` commands. Public control is `run`, `status`, `inspect`,
  `resume` (plus setup and hygiene: `doctor`, `init`, `profile-check`,
  `diagnostic-bundle`, cleanup).
- Parallel objectives are an execution optimization inside this workflow,
  not a mode (see `docs/features/parallel-objectives.md`).
- Operational failures use bounded retry and recovery; they never become
  product decisions on their own.

## Consequences

- Agents reason about one lifecycle; recovery and inspection have a
  single state vocabulary.
- All progress limits (role retries, correction rounds, timeouts) must be
  explicit and bounded, since no human will rescue a stuck stage.
- `human_decision_required` stays nonterminal until an explicit future
  protocol resolves it or the run is abandoned via recovery.

## Rejected alternatives

- Per-stage human approvals: reintroduces the interruption the product
  exists to remove; replaced by commit-bound gates in ADR-0008.
- Pilot / shadow / adoption modes: multiplies lifecycle, permission, and
  publication matrices for no accepted use case.
- File-presence completion (for example, trusting `.agent` artifacts):
  uncheckable and unrecoverable; rejected in favor of Git-derived results
  (ADR-0007).

## Enforcement / verification

- State union and transition function live in `src/domain/` with
  exhaustive unit tests, including illegal-transition rejection.
- CLI surface test asserts the public command set and rejects mode
  flags and stage-approval commands.
- `docs/features/product-and-modes.md` is normative for the single
  operating model; behavior changes update it alongside code and tests.
