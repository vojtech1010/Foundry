# 017 — Architect delivers a bounded plan and acceptance criteria

## Requirement

Architect writes an ordinary Markdown plan and supplies only a small machine
envelope: whether work is needed, the acceptance criteria, whether a live
application must be exercised, and whether execution is sequential or
parallel. Foundry assigns stable criterion IDs. The written plan is evidence;
Foundry never infers the outcome from prose or from the role simply stopping.

## Observable outcome

- A ready plan, a no-change candidate, or a blocked plan are the only Architect
  outcomes.
- Criteria are retained in the operator's words; Foundry labels them in order.
- Whether live testing is required comes from the accepted envelope, not from
  a later role's preference.
- A missing or invalid envelope gets at most one same-session repair, then the
  Architect retry budget.

## Not in this task

Splitting work across parallel Coders, or implementing the plan.

## Depends on

[016](016-role-permissions.md), [013](013-frozen-guidance.md)

## Spec

- [Plan-controlled validation](../features/running-work.md#plan-controlled-validation)
- [Free-form handoffs](../features/protocol-contracts.md#free-form-handoffs-with-a-narrow-control-envelope)

## Size guess

~10 files / ~450 lines
