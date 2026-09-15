# 056 — Move the role-host adapter into Foundry

## Requirement

Foundry serves the bundled role-host operations inside its own process instead
of invoking a separate adapter executable for each `capabilities`, `create`,
`submit`, `observe`, and `stop` request. Vendor agent harnesses remain isolated
behind the role-host boundary and may still run as child processes.

## Observable outcome

- A run and `doctor` use an application-owned role-host service directly; they
  do not resolve or spawn a role-host adapter command.
- The five existing role-host operations keep their closed request and response
  contracts, typed failures, ownership checks, generations, monotonic event
  sequences, and bounded outputs.
- Session identity, accepted idempotency keys, observations, settled narrative
  and control, and stop disposition survive a Foundry process restart in
  Foundry-owned durable storage.
- Recovery reconciles an interrupted create or submit without creating a second
  agent session or repeating an ambiguously accepted prompt.
- Capability reporting comes from the bundled harness implementations and fails
  closed when a selected harness cannot enforce its declared filesystem or
  network profile.
- `runtimeIdentity` continues to record the adapter version, provider, model,
  and tool profile actually assigned to each role session.
- Cleanup disposes only a session whose durable ownership token and generation
  match; uncertain ownership remains a recorded cleanup failure.

## Not in this task

Changing role outcomes or workflow routing, weakening role permissions, adding
manual execution modes, selecting a terminal multiplexer, or moving vendor
model execution into the Foundry process.

## Depends on

[014](014-role-conversations.md), [015](015-capable-role-host.md),
[035](035-resume-without-repeating-work.md),
[037](037-cleanup-keeps-the-result.md),
[053](053-per-role-harness-models.md),
[054](054-bundled-role-host.md)

## Spec

- [Role-host protocol](../features/protocol-contracts.md#role-host-protocol)
- [Role recovery](../features/recovery.md#role-recovery)
- [Validate before work](../features/project-setup.md#validate-before-work)

## Size guess

~12 files / ~500 lines; split durable adapter-state migration from
vendor-harness implementations if the change exceeds this bound.
