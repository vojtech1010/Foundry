# ADR-0012: Authenticated GitHub Decision Commands

- Status: Accepted
- Date: 2026-09-11
- Supersedes: the deferred inbound-reconciliation portion of ADR-0008
- Relates to: `docs/features/results-and-publication.md`,
  `docs/features/recovery.md`

## Context

ADR-0008 deliberately deferred applying a human answer from GitHub because
ordinary comments, approvals, and merge activity are ambiguous. Leaving every
decision run permanently pending would make the workflow operationally
incomplete, while adding a broad manual-control mode would violate Foundry's
single autonomous model.

## Decision

- Reviewer decision options have a label and one action: `accept`, `correct`, or
  `abandon`. Foundry assigns decision/option IDs and a fresh 128-bit nonce.
- The owned draft PR displays an exact `/foundry decide ...` command for each
  option. `resume` reads comments and accepts only a whole-comment command from
  a human whose current repository permission is `maintain` or `admin`.
- PR identity, draft/open state, and exact head commit must still match. The
  accepted comment and authorization evidence become a durable event before any
  transition.
- Same-option duplicates are idempotent; conflicting valid options or uncertain
  identity stop for human recovery.
- `accept` completes with an explicit human-decision reason, `correct` grants one
  Coder correction followed by all gates, and `abandon` enters terminal
  `abandoned`.
- No other GitHub activity is interpreted. Foundry still never merges, closes,
  approves, or treats a GitHub merge as workflow completion.

## Consequences

- A person makes one bounded choice in the existing PR; there is no manual stage
  approval workflow.
- A human can explicitly accept a risk Reviewer could not approve, and the
  handoff preserves that distinction.
- A corrected result may reuse the same owned draft PR with a new decision ID,
  nonce, exact head, and body. Old commands cannot apply to the new decision.
- GitHub permission and comment APIs become part of publication recovery and
  require deterministic fakes and pagination tests.

## Rejected alternatives

- Treating approval, merge, labels, reactions, or prose as a decision: ambiguous
  and unauthenticated at the workflow-contract level.
- A general `approve` CLI command: bypasses the decision workspace and creates a
  second manual operating model.
- Webhooks as the only path: adds public service hosting and delivery recovery
  when an idempotent `resume` poll is sufficient.
- One-time URLs or a separate web UI: more infrastructure and identity surface
  than the current product needs.

## Enforcement / verification

- Contract tests cover exact command grammar, nonce and decision binding,
  option actions, author type, permission level, PR identity, and head commit.
- Recovery tests cover pagination, duplicate comments, conflicts, comment
  edits/deletion after acceptance, and interruption before/after the decision
  event.
- Transition tests prove ordinary GitHub activity has no effect and each action
  reaches only its declared route.
