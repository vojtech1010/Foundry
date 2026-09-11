# Parallel objectives

Foundry may split one accepted plan into independent Coder objectives. This is
an execution optimization inside the single autonomous workflow, not a separate
mode or an operator-selected stage sequence.

## Use only for independent work

Parallel objectives are appropriate when every objective can start from the
same source commit and finish without another objective's unfinished output.
Prefer sequential implementation when objectives share generated files,
migrations, dependency updates, or ordering constraints.

The accepted plan is authoritative. Foundry compiles the Architect's free-form
narrative and narrow control envelope into either:

- one sequential objective; or
- at least two independent parallel objectives with unique IDs and complete
  acceptance-criterion coverage.

There is no public `--parallel` flag. Foundry validates the plan and selects the
execution path automatically. Parallelism is opt-in: missing, overlapping, or
incomplete objective metadata falls back to one sequential objective without a
human question.

## Worker contract

1. Every objective starts at the run's confirmed source commit.
2. Each worker receives its own run-owned worktree, branch, and Coder session.
3. Coder is the only role allowed to modify production files.
4. A successful objective must produce a verifiable commit.
5. Lead Coder integrates every accepted objective commit, resolves overlap,
   completes remaining plan work, and commits the aggregate.
6. The integrated commit enters the same deterministic checks, optional Tester,
   Reviewer, correction, and decision-escalation path as sequential work.

Worker branch names are derived, not agent-selected:
`<task-branch>--worker-<objective-id>-<run-hash>`, where `run-hash` is the first
12 lowercase hexadecimal characters of SHA-256 over the run ID. Lead Coder owns
the configured task branch. Branch and worktree collision rules are identical
to the top-level run: reuse requires the same durable owner and recorded head;
otherwise Foundry blocks without moving either resource.

The configured `maxParallelCoders` limit bounds active workers. Fewer objectives than
slots leave capacity unused; concurrency never changes the plan's dependencies.
Each objective and Lead Coder receives the configured Coder role-retry budget;
the run-wide correction-round budget begins only after an aggregate commit
enters verification.

## Worker lifecycle and integration provenance

Retain a durable record for each objective worker and Lead Coder: objective and
worker identity, source commit, assigned branch/worktree, runtime ownership and
working directory, submission/observation progress, result commit, and cleanup
outcome. Record creation, progress, settled result, and disposal separately.
An accepted worker commit does not prove its session or worktree was disposed.

Worker completion order may vary. Integration records the complete accepted
objective/commit set and declared integration order before Lead Coder starts;
arrival order must not silently redefine the plan. A declared order is not by
itself proof of the chronological Git operations performed by Coder. Retain the
actual contribution-application sequence and corresponding Git commits in durable
integration evidence, with an explicit reason for any deviation from declared
order. Verify the aggregate against the accepted contributions and plan
constraints using Git and that evidence rather than assuming the journal's
order proves inclusion.

Keep objective result artifacts, worker records, and integration evidence
linked through hashes and Git-derived scopes/diffs. Worker-reported commits or
file lists are inputs to validation, not authority. Record Lead Coder's aggregate
commit and contributors in the run's accepted-commit provenance; bind checks,
Reviewer, and the handoff to that aggregate. A sparse top-level Coder summary
must not replace the durable integration record.

## Failure behavior

Lead Coder does not begin until every objective has a valid commit. Foundry never
tests or reviews a partial aggregate.

| Situation                              | Behavior                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| Objective fails or lacks a commit      | Stop queued work, drain active workers, clean owned resources, and retry within budget |
| Worker commit drifts or disappears     | Reject integration and preserve evidence                                               |
| Lead Coder cannot integrate            | Retry within budget, then block                                                        |
| Interruption follows submission        | Reattach and observe through recovery; never resubmit blindly                          |
| Integration succeeds but cleanup fails | Keep the accepted result and report a cleanup warning                                  |

A worker commit is evidence, not a separate user deliverable. The only candidate
result is the integrated commit.

## Interaction with human decisions

Parallel work does not create additional approval gates. Reviewer approval
completes normally. If Reviewer needs human judgment after automatic correction
routes are exhausted, Foundry publishes the integrated commit as the draft PR
described in [results and publication](results-and-publication.md).

Workers, branches, worktrees, and records must never be edited manually. Use
[recovery](recovery.md) to reconcile interrupted sessions or uncertain cleanup.
