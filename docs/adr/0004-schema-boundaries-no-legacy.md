# ADR-0004: Strict Schema Boundaries and Pre-1.0 No-Legacy Policy

- Status: Accepted
- Date: 2026-09-08
- Relates to: `docs/features/project-setup.md`

## Context

Foundry ingests untrusted data at many edges: CLI arguments, JSON
config, request documents, role outputs, GitHub payloads, and persisted
run records. Permissive parsing turns typos and version skew into silent
misbehavior deep in the workflow.

## Decision

Every trust boundary decodes through an explicit Effect Schema contract:

- Covered edges: CLI input, `foundry.config.json`, request files, role
  prompt contracts and outputs, persisted events and journals, GitHub
  API payloads.
- Schemas are closed: unknown fields are rejected with an actionable
  error naming the offending field and the expected `schemaVersion`.
- `decisionPublication.draft` is always `true`; `decisionPublication`
  remote must equal `sourceRemote`. Non-draft automated publication is
  not representable.
- Pre-1.0 compatibility policy: no legacy support. A breaking contract
  change bumps `schemaVersion` (or the prompt contract version) and
  rejects older documents. No dual-read shims, silent defaults that
  change meaning, or compatibility flags unless a dedicated ADR
  justifies a specific migration.

## Consequences

- Misconfiguration fails fast at `doctor` / startup instead of
  mid-workflow.
- Pre-1.0 iteration stays fast, at the cost of requiring users to update
  configs and requests on version bumps.
- Guidance snapshots and prompt contracts must version alongside the
  schemas that validate them.

## Rejected alternatives

- Permissive parsing with passthrough unknowns: hides drift and breaks
  recovery matching.
- A second validation library beside Effect Schema: splits the contract
  language for no gain.
- Permanent backward-compatibility shims: freezes early mistakes into
  the state machine before 1.0.

## Enforcement / verification

- Contract tests per boundary, including unknown-field rejection,
  version-mismatch rejection, and golden samples of valid documents.
- `doctor` validates config, target identity, and publication readiness
  before any run starts.
- Typecheck plus `effect:diagnostics` keep schemas and tagged errors
  aligned with producers and consumers.
