# 039 — Export a bounded diagnostic snapshot

## Requirement

An operator can export a redacted support snapshot of a run. The destination
must be new or empty and must sit outside live run storage. A bundle is not a
complete archive and is not automatically safe to publish.

## Observable outcome

- The snapshot includes a manifest of included entries, byte counts, hashes,
  redaction counts, and truncation.
- Secrets should already be out of requests and logs; redaction is a last
  defense, not a security boundary.
- JSON output uses the same versioned success or error envelope as other
  commands.

## Not in this task

Defining retention deletion, or making redaction patterns configurable.

## Depends on

[033](033-inspect-evidence.md), [042](042-bounded-redacted-evidence.md)

## Spec

- [Diagnostic bundles](../features/inspection-and-reporting.md#diagnostic-bundles)

## Size guess

~8 files / ~400 lines
