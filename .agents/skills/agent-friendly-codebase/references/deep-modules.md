# Deep Modules

## Definition

A deep module exposes a small, stable interface while hiding substantial implementation complexity.

Conceptually:

```text
          small interface
        ┌───────────────┐
        │ placeOrder()  │
        │ cancelOrder() │
        │ getOrder()    │
        ├───────────────┤
        │               │
        │ substantial   │
        │ hidden logic  │
        │               │
        └───────────────┘
```

The goal is not large files. Internals may be decomposed freely as long as callers do not need to understand them.

## Agent benefit

Deep modules act as context compression. Most agents can reason from the public seam and tests without loading persistence, retries, provider adapters, orchestration, and other internals.

## Prefer deepening an existing seam

Before creating another public service/interface/helper, ask whether the existing owning module can absorb the behavior behind its current interface.

## Warning signs of shallow modules

- wrapper forwards nearly every parameter unchanged;
- interface and implementation contain nearly identical methods;
- caller must understand implementation-specific types;
- one behavior requires traversing many one-method classes;
- abstraction exists only to conform to a pattern;
- public API grows roughly in proportion to internal complexity.

## When another seam is justified

A seam is more likely useful when it:

- hides an external provider/protocol;
- centralizes a business invariant;
- represents a domain capability used by multiple callers;
- has demonstrated multiple implementations;
- protects volatility from callers;
- gives a natural testing boundary.

## File size

Do not use arbitrary file-size limits as a proxy for module quality. Very large files can still be a smell, but splitting a cohesive module into many tiny, highly coupled files may worsen agent locality.
