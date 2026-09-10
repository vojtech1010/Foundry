# ADR-0006: Role Capabilities — Coder-Only Writes, Read-Only Tester

- Status: Accepted
- Date: 2026-09-08
- Relates to: `docs/features/product-and-modes.md`,
  `docs/features/running-work.md`,
  `docs/features/quality-and-decisions.md`

## Context

Roles run with powerful harnesses against real repositories. If any role
can write production files or mutate application data by convention,
least privilege depends on prompt wording instead of enforcement, and
reviews cannot trust what they did not personally inspect.

## Decision

Capabilities are fixed and non-grantable:

- Only Coder may modify production project files, and only inside the
  run-owned worktree on the run-owned branch. Its result counts only as
  a verified commit.
- Architect, Tester, and Reviewer are read-only on production paths.
  Plans, prompts, and guidance cannot escalate them.
- Tester receives a Foundry-prepared runtime and produces observations
  tied to acceptance criteria. It has no authority to create, modify, or
  delete application data; no `testerScenarioAuthority` (or equivalent)
  field exists and any such field is rejected by schema.
- There is no mandatory visual-variant matrix or screenshot attestation
  gate. Captures are optional evidence, never a separate authority, and
  their absence never fails an otherwise adequate result.
- Runtime lifecycle (reset, build, start, readiness, stop, cleanup)
  belongs to Foundry, not to Tester. Data-mutating validation belongs in
  project-owned isolated automated tests; otherwise the limitation is
  recorded for Reviewer.

## Consequences

- Reviews can assume non-Coder roles left the tree untouched, subject to
  path-containment enforcement.
- Some runtime scenarios cannot be validated live; those limits become
  explicit findings instead of silent Tester writes.
- Prompt contracts and schemas must both encode the same capability
  matrix so violations fail closed.

## Rejected alternatives

- Plan-granted Tester mutation rights: trades auditability for
  convenience and leaks test data into shared services.
- Mandatory named visual-variant evidence: gates quality on a capture
  matrix instead of criterion coverage.
- Tester-owned runtime lifecycle: mixes observation with environment
  control and complicates recovery ownership.

## Enforcement / verification

- Path-containment tests assert non-Coder roles cannot write production
  paths, including symlink and `..` escapes.
- Schema tests reject mutation-grant fields in plans and Tester
  contracts.
- Prompt-contract tests assert capability text is present and immutable
  for the run; guidance-overrides-permission attempts are rejected.
