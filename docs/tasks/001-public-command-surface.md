# 001 — One small public command set with consistent reports

## Requirement

An operator talks to Foundry through a small, fixed set of commands. There is
no separate command to approve a stage, reject a stage, or drive coding,
testing, or review by hand. Every command answers with one versioned success
or error report. Exit codes distinguish a finished durable outcome, a blocked
or failed run, a setup mistake before a run exists, and an operator interrupt.

## Observable outcome

- The operator can name `run`, `resume`, `status`, `inspect`, `doctor`,
  `init`, `profile-check`, `diagnostic-bundle`, and `cleanup`.
- Commands such as `approve`, `reject`, `code`, `test`, and `review` are not
  part of the product.
- JSON output is one envelope. Human-readable output presents the same facts
  and is not a second source of truth.
- A later command may still say the work is not available, but the report
  shape and exit-code meanings are already stable.

## Not in this task

Starting a real run, checking a project, or inspecting evidence.

## Depends on

None.

## Spec

- [Product and operation](../features/product-and-modes.md)
- [CLI result contract](../features/protocol-contracts.md#cli-result-contract)

## Size guess

~10 files / ~400 lines
