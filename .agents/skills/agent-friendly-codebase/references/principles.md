# Principles

## 1. Locality beats superficial simplicity

For agent maintainability, the important question is not "How small is each file?" but "How much unrelated context must an agent load to safely make one change?"

Favor cohesive modules and colocated behavior over excessive fragmentation and indirection.

## 2. Hide complexity behind narrow seams

Public surface area consumes context repeatedly. Internal complexity is paid mainly by agents working inside that module.

Therefore, minimize the concepts every caller must know.

## 3. Encode invariants as executable constraints

A prose rule can be forgotten. A type error, lint failure, schema failure, or architecture test enters the agent's feedback loop automatically.

## 4. Prefer explicit ownership

A future agent should be able to answer "where does this behavior belong?" from repository structure and architecture docs, not tribal knowledge.

## 5. Make feedback cheap

Agents self-correct well when feedback is fast, deterministic, and close to the changed code.

## 6. Optimize for the next agent

The relevant maintainer may have no memory of today's conversation. Preserve rationale, vocabulary, contracts, tests, and constraints in-repo.

## 7. Fix systems, not repeated prompts

When the same mistake recurs, strengthen the repository environment: interface, type, test, lint, documentation map, or tooling.

## 8. Improve incrementally

Agent throughput makes large rewrites tempting. Prefer small migrations that continuously leave the repository valid and verifiable.
