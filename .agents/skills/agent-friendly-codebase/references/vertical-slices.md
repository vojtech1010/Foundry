# Domain Locality and Vertical Slices

## Preferred mental model

Organize primarily by business/domain ownership, then colocate feature/use-case behavior where that improves locality.

Example:

```text
billing/
  index.ts
  refund/
    command.ts
    handler.ts
    validator.ts
    refund.test.ts
  invoice/
    ...
  internal/
    persistence/
```

Instead of forcing one feature across global folders:

```text
controllers/
services/
repositories/
validators/
models/
```

## Why this helps agents

A task such as "change refund validation" should lead naturally to one owning area, reducing search and context expansion.

## Avoid cargo-cult slicing

Do not duplicate shared domain invariants in every feature folder. Centralize concepts that genuinely belong to the domain as a whole.

## Shared code threshold

Move code to shared infrastructure only when ownership is genuinely cross-domain. A helper used twice is not automatically a global utility.

Prefer domain-owned shared code over a global `utils` dumping ground.
