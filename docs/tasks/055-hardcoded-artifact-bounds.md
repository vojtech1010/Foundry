# 055 — Hardcode artifact bounds; drop them from configuration

## Requirement

Foundry uses one hardcoded set of artifact bounds
(`retentionDays`, all `max*Bytes` limits). The `artifacts` block leaves
the configuration document: a document containing it is rejected as an
unknown field under the closed-document rule.

## Observable outcome

- Configuration without `artifacts` is accepted; the hardcoded bounds
  apply to every run on every project.
- Requests, guidance, handoffs, evidence, and terminal captures keep
  today's limit behavior, only the source of the numbers changes.
- `doctor` and `init --dry-run` report the effective bounds from the
  hardcoded set.
- Existing tests that build configuration documents are updated to omit
  the block.
- The accepted cost is explicit: projects can no longer extend
  `redactionPatterns` with their own secret shapes; the hardcoded set
  plus never persisting credentials is the whole accidental-disclosure
  defense.

## Not in this task

Changing any limit value's behavior, per-stage approval modes, or the
role-host configuration from 053–054.

## Depends on

[002](002-project-configuration.md), [042](042-bounded-redacted-evidence.md)

## Spec

- [Configuration shape](../features/project-setup.md#configuration-shape)
- [Artifact limits](../features/protocol-contracts.md#artifact-limits)

## Size guess

~6 files / ~250 lines
