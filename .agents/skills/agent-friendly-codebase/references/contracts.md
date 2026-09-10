# Explicit Contracts

## Principle

Convert assumptions into machine-readable contracts whenever practical.

Prefer:

- static types;
- runtime schemas for untrusted/external data;
- OpenAPI/GraphQL/Protobuf-generated clients;
- DB schemas/migrations;
- event schemas;
- configuration schemas;
- contract tests.

## Boundary validation

External JSON, user input, queue events, environment/config data, third-party SDK responses, and persistence data with uncertain shape should be validated or represented by a trustworthy typed contract.

Do not spread raw external representations throughout the domain.

When the repository depends on `effect`, treat `Schema.TaggedError` and the
Effect error channel as the contract for **new** failure-classified async
work in allowed layers. Do not replace an existing TypeBox/JSON Schema
document contract with Effect Schema unless a dedicated plan requires it.

Prefer:

```text
external representation
       ↓
validate/map at boundary
       ↓
domain representation
```

## Vocabulary

Use one name for one domain concept. If `Policy`, `Quote`, and `Contract` have distinct business meanings, record them and avoid agents inventing synonyms.

## Public contract stability

Changing a public seam increases blast radius. Prefer backward-compatible extension or internal change when the caller does not need to know about new implementation details.
