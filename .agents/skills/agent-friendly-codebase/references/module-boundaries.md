# Module Boundaries

## Goal

Make architectural dependency rules explicit and mechanically checkable.

## Typical rules

Examples:

```text
UI -> Application -> Domain
             |
             v
         Ports/contracts
             ^
             |
       Infrastructure
```

or repository-specific domain layers such as:

```text
Types -> Config -> Repository -> Service -> Runtime -> UI
```

The exact model matters less than having a coherent, limited set of allowed directions.

## Cross-domain access

Prefer one explicit public seam per domain/package. Avoid callers importing implementation subpaths.

Example:

```text
GOOD
billing -> payments/public-api

BAD
billing -> payments/internal/stripe/retry-state
```

## What to enforce

High-value enforcement targets:

- forbidden dependency directions;
- forbidden internal imports;
- domain ownership boundaries;
- cycles;
- shared-package restrictions;
- external-data validation requirements;
- platform constraints that prevent real failures.

## What not to over-enforce

Avoid mechanical rules whose only purpose is personal style, such as mandatory numbers of classes/files or arbitrary pattern usage.

## Error messages

When custom architecture checks are built for agents, make failures actionable:

```text
Forbidden dependency: billing may not import payments/internal/*.
Import from payments/index.ts or add the required capability to the Payments public API.
```

An actionable failure doubles as just-in-time agent instruction.
