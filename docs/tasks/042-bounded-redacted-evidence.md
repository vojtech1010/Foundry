# 042 — Retained logs stay size-bounded and accidentally secret-free

## Requirement

Mandatory history, machine envelopes, and the canonical handoff are never
silently cut short. Optional logs and captures are kept up to configured
limits. Configured redaction patterns are applied before persistent logs and
bundles are written. If mandatory history cannot be written, the run stops
safely as blocked.

## Observable outcome

- Optional evidence records original size, retained size, hash when fully
  seen, truncation, and redaction count.
- Once the run size limit is reached, optional evidence is refused and the
  run continues on mandatory evidence when possible.
- Redaction patterns are checked during `doctor`.
- Secrets still do not belong in requests or logs; redaction is only a last
  defense.

## Not in this task

Diagnostic bundle layout, or the first event-history write itself.

## Depends on

[009](009-trustworthy-run-history.md), [003](003-readiness-check.md)

## Spec

- [Artifact limits](../features/protocol-contracts.md#artifact-limits)

## Size guess

~8 files / ~400 lines
