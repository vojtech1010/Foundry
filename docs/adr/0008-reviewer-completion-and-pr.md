# ADR-0008: Local Reviewer Completion, Decision-Only Draft PR, Deferred Reconciliation

- Status: Accepted
- Date: 2026-09-08
- Inbound decision reconciliation superseded by: ADR-0012
- Relates to: `docs/features/quality-and-decisions.md`,
  `docs/features/results-and-publication.md`

## Context

Ordinary runs should finish without human involvement, but some
reviewable results pose genuine product or risk trade-offs automation
must not settle. Publishing every run as a PR trains humans to rubber
stamp, while guessing decisions from GitHub activity invents approvals.

## Decision

- Reviewer `approved` completes the run locally. No PR is created for
  ordinary approvals or for `completed_no_change`. There are no manual
  `approve` / `reject` commands.
- Only a genuine `human_decision_required` outcome — reviewable commit
  plus an explicit question, options, recommendation, findings,
  commits, evidence, and why automation cannot proceed — creates or
  reuses exactly one draft PR for the exact task-head/source-base pair,
  following the journaled push-then-reuse-or-create sequence.
- Operational states (`blocked`, `failed`, `publish_failed`, ineligible
  remote) never create a speculative PR.
- Inbound GitHub decision reconciliation is explicitly deferred.
  Comments, approvals, closure, and merge are not machine-readable
  decisions. The run stays `human_decision_required` with its question,
  exact commit, evidence, and PR URL preserved until a future ADR
  defines an authenticated, structured reconciliation protocol.

## Consequences

- The PR is a decision workspace, not a merge-ready proposal; its body
  must say what is being asked, not imply approval.
- Decision-escalated runs remain nonterminal and recoverable, which
  requires retention and inspection to preserve them.
- A future reconciliation ADR will need authentication, decision shape,
  idempotency, and audit rules; nothing in this ADR pre-commits to a
  comment-driven design.

## Rejected alternatives

- PR per completed run: noise that buries real decisions and implies
  merge readiness Foundry never promises.
- Non-draft automated PRs: unsupported; automation must not present
  unreviewed-by-human work as mergeable.
- Inferring resolution from approvals, comments, closure, or merge:
  unauthenticated and ambiguous; explicitly forbidden.

## Enforcement / verification

- Tests assert no PR path executes for `approved` and
  `completed_no_change`.
- Publication tests assert exact-pair reuse (no duplicate PRs),
  pre-push verification order, and journaled resume after interruption.
- Tests assert GitHub activity alone never transitions a run out of
  `human_decision_required`.
