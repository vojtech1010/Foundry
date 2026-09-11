# 006 — Start from one written request and unique IDs

## Requirement

A run records one operator-written request, one run ID, and one task ID. The
request is ordinary Markdown with no required headings. Foundry keeps both
what the operator wrote and the normalized text it will show to roles. A
duplicate run ID is refused.

## Observable outcome

- The operator supplies `--request`, `--task-id`, and `--run-id`.
- Empty, oversized, or non-UTF-8 requests fail before a durable run exists.
- IDs are short, stable names the operator chose; Foundry does not invent them
  in this version.
- The request is retained as evidence for that run and is not reread from a
  live file later to change what was asked.

## Not in this task

Planning, coding, or advancing workflow state beyond recording the request.

## Depends on

[002](002-project-configuration.md)

## Spec

- [Write a useful request](../features/running-work.md#write-a-useful-request)
- [Paths, identifiers, and Git baseline](../features/protocol-contracts.md#paths-identifiers-and-git-baseline)

## Size guess

~8 files / ~350 lines
