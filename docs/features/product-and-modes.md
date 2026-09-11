# Product and operation

Foundry turns a written request into a validated, reviewable change with as few
human interruptions as possible. It coordinates Architect, Coder, Tester, and
Reviewer roles while Foundry owns state, deterministic checks, Git safety, and
recovery.

```text
request -> Architect -> Coder -> deterministic checks -> optional Tester -> Reviewer
                                                                        |
                                                approved ---------------+--> completed
                                                changes requested ------+--> correction loop
                                                human decision needed --+--> draft GitHub PR
```

## Supported host platforms

Foundry supports running on Linux and Windows. Platform-specific command and
path handling must preserve the same autonomous workflow, role permissions,
Git-safety guarantees, and recovery behavior on both operating systems.

## One operating model

Foundry has one operating model: autonomous execution. There is no manual,
shadow, pilot, or adoption mode.

- **Architect** creates a bounded plan and acceptance criteria. It is read-only.
- **Coder** is the only role allowed to modify production project files. It must
  commit its result on the run-owned task branch.
- **Tester** may inspect and exercise a prepared runtime when the plan requires
  runtime validation. It remains read-only and receives no authority to create,
  modify, or delete application data.
- **Reviewer** evaluates the accepted plan, Git-derived implementation, checks,
  runtime observations, findings, and correction history. It is read-only.
- **Foundry** advances accepted work and routes bounded corrections without
  asking a person to approve ordinary stages.

Role-host selection is an implementation concern, not a product mode. An
in-process fake Layer is used for deterministic development tests; a configured
`foundry-role-host-v1` adapter performs real role work. Neither changes
permissions or publication policy.

Role handoffs are free-form Markdown with only a narrow machine control
envelope for workflow routing. Agents never need to reproduce Foundry's durable
state or evidence schemas. See [protocol contracts](protocol-contracts.md).

## Human interruption policy

Human judgment is exceptional. Foundry asks for it only when Reviewer has a
reviewable implementation but cannot safely choose approval or another bounded
Coder correction.

Examples include:

- a product or policy trade-off not settled by the request;
- acceptance criteria that admit materially different interpretations;
- unresolved findings requiring an explicit risk decision; or
- exhausted correction routing where a person must choose whether to accept,
  revise, or abandon the result.

When this happens, Foundry non-force-pushes the exact recorded task-branch commit
and creates or reuses a draft GitHub pull request containing the evidence and
open decision. The run enters `human_decision_required`.

Operational failures are not human product decisions. Missing credentials,
unavailable runtimes, malformed state, lock uncertainty, or failed commands are
handled by bounded retry and [recovery](recovery.md). They do not create a PR
unless Reviewer has already produced a reviewable decision escalation.

The draft PR presents explicit option commands. `resume` accepts only a nonce-
bound command from a human with `maintain` or `admin` permission; it never
guesses from ordinary comments, approval, closure, merge, or other GitHub
activity. See [results and publication](results-and-publication.md#applying-a-human-decision).

## What Foundry never does

Foundry never:

- gives a read-only role permission to change production files;
- treats file existence or role termination as successful completion;
- resubmits an interrupted role prompt when recovery can reattach;
- force-pushes, merges, deploys, or rewrites history;
- edits the source branch; or
- invents a human answer from GitHub state.

All operations remain bounded by strict schemas, timeout and retry budgets,
repository locking, path containment, atomic persistence, and Git-derived
provenance. See [running work](running-work.md) for the lifecycle and
[quality and decisions](quality-and-decisions.md) for review outcomes.

## Reverse-engineering evidence

The [successful-run evidence appendix](run-history-evidence.md) maps retained
`project-c` runs to these specifications. It distinguishes demonstrated
orchestration behavior, historical limitations, and deliberate exclusions.
Legacy publication policy, Quality Engineer execution, and Tester data mutation
are not Foundry capabilities merely because an older run completed with them.
These are intended product contracts, not a claim that Foundry's skeleton
already implements the observed behavior.
