# Running work

A Foundry run records one request, one authoritative source revision, one plan,
and every accepted transition through Architect, Coder, checks, optional Tester,
and Reviewer. The workflow advances autonomously; there are no commands for a
person to approve each stage.

## Start a run

From the Foundry checkout:

```powershell
node dist/cli/index.js run `
  --config .\target\.agent\foundry.config.json `
  --request .\requests\change.md `
  --task-id example-change `
  --run-id RUN-EXAMPLE-001 `
  --json
```

`run` owns the complete lifecycle. Separate public `code`, `test`, `review`,
`approve`, and `reject` commands are not part of the product surface. Use
`status` and `inspect` for observation and `resume` after interruption.

## Write a useful request

Describe outcomes rather than instructions for individual roles:

```markdown
# Outcome

What should be different for the user or operator?

# Acceptance

What observable examples prove the result works?

# Constraints

What behavior, interfaces, dependencies, or data must remain unchanged?

# Non-goals

What nearby work is excluded?

# Runtime needs

Does success require a running application?
```

Keep unrelated goals separate. Name independent parts and shared-file risks if
parallel implementation may help, but the accepted plan controls execution.

## Lifecycle

1. **Provision source.** Fetch the configured source branch, freeze its commit
   without touching the operator checkout, acquire the repository lease, and
   create run-owned storage plus the task branch and worktree at that commit.
   Until the durable `worktree-ready` checkpoint exists the run derives
   `blocked`; a colliding branch or workspace that this run cannot prove it owns
   blocks without moving or deleting it.
2. **Plan.** Architect produces a strictly validated plan with acceptance
   criteria and a runtime-validation decision.
3. **Implement.** Coder implements the accepted plan and commits on the task
   branch. Parallel objectives may be selected by the plan.
4. **Verify.** Foundry runs configured format, lint, typecheck, test, and build
   commands against the recorded implementation commit.
5. **Test when required.** Tester observes the prepared application without
   mutating application data. Runtime startup and cleanup remain Foundry
   responsibilities.
6. **Review.** Reviewer evaluates the current commit and evidence.
7. **Route automatically.** Approval completes the run; actionable findings
   enter a bounded Coder correction loop; a genuine product decision creates a
   draft GitHub PR and enters `human_decision_required`.
8. **Clean up.** Foundry releases owned runtime and worktree resources while
   preserving the result and bounded evidence.

A request already satisfied by the source may complete as
`completed_no_change`. It has no implementation commit and cannot require a
review-decision PR.

Architect or Coder may nominate a no-change candidate, but neither declaration
is authoritative. Foundry first verifies that the task branch is clean and has
no source-relative diff, runs the deterministic profile against the frozen
source commit, and sends the request, rationale, source, and verification report
to Reviewer. Reviewer approval produces `completed_no_change`; requested
implementation enters Coder without consuming a correction round.
`human_decision_required` is invalid for a no-change candidate because there is
no reviewable implementation to publish; unresolved ambiguity routes to Coder
or `blocked`.

## Plan-controlled validation

The accepted, machine-validated plan records stable acceptance-criterion IDs,
affected path scopes, whether runtime validation is required, and the rationale
for that decision. These fields determine validation routing; a role's prose
claim or preference cannot silently enable or omit Tester.

Architect writes the plan as ordinary Markdown and supplies only the compact
routing envelope described in [protocol contracts](protocol-contracts.md). Foundry
assigns stable criterion and objective IDs. Sequential execution is the safe
default whenever parallel metadata is absent or cannot prove independence.

Deterministic verification runs before required runtime preparation. When the
plan does not require Tester, Foundry records an explicit skip with its reason
and proceeds to Reviewer using the verification report. No Tester invocation or
synthetic passed Tester artifact is needed. A skipped Tester is not a claim that
live application behavior was exercised, and command-log filenames are not
proof that a Tester session ran.

## Corrections

A correction always returns to Coder, creates a new Foundry-recorded commit,
and invalidates downstream evidence from earlier commits. Foundry reruns the
required checks, Tester stage when applicable, and Reviewer.

Any accepted result-head change invalidates earlier commit-bound checks and
downstream observations, not just a change labeled as a correction. Record the
invalidation reason and the new verification attempt; never mix evidence from
two result commits into one approval.

Correction and role retry budgets are distinct. Exhaustion does not silently
approve the result. Reviewer may escalate the remaining decision to a draft PR
when a reviewable commit exists; technical failure without a reviewable decision
remains blocked or failed.

## Runtime testing boundary

Tester is read-only. Plans cannot grant scenario authority to create, change, or
delete application records. Foundry does not require a matrix of named visual
variants or structured screenshot attestations. Tester may cite bounded logs,
outputs, or optional captures as observations, but those are ordinary evidence,
not a separate authority system.

If meaningful runtime validation inherently requires data mutation, the plan
must prefer deterministic isolated tests owned by the project. Otherwise it
records the limitation for Reviewer rather than granting Tester write access.

## Important states

| State                                                     | Meaning                                        | Automatic action                                            |
| --------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| `planning`, `coding`, `verifying`, `testing`, `reviewing` | A stage is active                              | Continue within configured bounds                           |
| `correcting`                                              | Coder is addressing accepted findings          | Reverify and rereview the new commit                        |
| `human_decision_required`                                 | Reviewer needs a product decision              | Wait for one authenticated option command                   |
| `completed`, `completed_no_change`                        | Successful terminal result                     | Produce the final handoff and clean owned resources         |
| `abandoned`                                               | An operator explicitly ended a nonterminal run | Preserve the reason and clean only verified owned resources |
| `blocked`                                                 | A recoverable prerequisite stopped progress    | Preserve evidence and resume after correction               |
| `failed`                                                  | No safe route or reviewable result remains     | Preserve evidence; start a new run only for a new attempt   |

Never infer success from files in `.agent`. A successful change requires a
validated state transition and Git-derived result commit. See
[inspection and reporting](inspection-and-reporting.md).

## Legal transition routes

Retries and control repairs retain the current workflow state and append a new
attempt or repair event. State changes use only these routes:

| From                                 | To                        | Required fact                                                                                        |
| ------------------------------------ | ------------------------- | ---------------------------------------------------------------------------------------------------- |
| run creation                         | `planning`                | source, lease, storage, and worktree provisioning checkpoints are durable                            |
| `planning`                           | `coding`                  | accepted plan requires implementation                                                                |
| `planning`                           | `verifying`               | accepted no-change candidate                                                                         |
| `coding`, `correcting`               | `verifying`               | clean assigned branch with a new Git-derived candidate commit, or a validated no-change candidate    |
| `verifying`                          | `testing`                 | checks passed and accepted plan requires runtime validation                                          |
| `verifying`                          | `reviewing`               | checks passed and Tester is not required, or correction budget is exhausted with a reviewable commit |
| `verifying`, `testing`, `reviewing`  | `correcting`              | evidence-backed Coder work remains and a correction round is available                               |
| `testing`                            | `reviewing`               | settled Tester observations or a retained runtime limitation                                         |
| `reviewing`                          | `testing`                 | Reviewer requested another observation against the same commit and a Tester retry remains            |
| `reviewing`                          | `completed`               | Reviewer approved the exact changed commit and current evidence                                      |
| `reviewing`                          | `completed_no_change`     | Reviewer approved the verified source as already satisfying the request                              |
| `reviewing`                          | `publishing`              | valid `human_decision_required` envelope and a reviewable changed commit                             |
| `reviewing`                          | `blocked`                 | valid human-decision result but decision publication is not configured or eligible                   |
| `publishing`                         | `human_decision_required` | exact draft PR URL durably reconciled                                                                |
| `publishing`                         | `publish_failed`          | publication cannot yet be reconciled safely                                                          |
| `human_decision_required`            | `completed`               | authenticated `accept` option                                                                        |
| `human_decision_required`            | `correcting`              | authenticated `correct` option; downstream evidence is invalidated                                   |
| any nonterminal state                | `abandoned`               | explicit abandonment request and reason are durably recorded                                         |
| any active state                     | `blocked`                 | a recoverable prerequisite or integrity condition prevents safe progress                             |
| any active state except `publishing` | `failed`                  | a non-recoverable validated failure or exhausted budget leaves no reviewable result                  |

`changes_requested` is valid only when a correction round remains. With a
reviewable commit but no remaining automatic correction, Reviewer must choose
`human_decision_required` for a genuine product/risk choice or `blocked` for an
operational/integrity problem. Failed required checks or missing required
runtime evidence can never lead to `approved`.

`resume` reconciles `blocked` or `publish_failed` from its durable checkpoint
and returns to the recorded active state only after the prerequisite is valid.
`failed`, `abandoned`, `completed`, and `completed_no_change` are terminal.
Cleanup progress is recorded separately and never changes an accepted result
state.

## Transition gate

A recorded workflow state changes only through a typed transition route from
the table above. The route request carries the fact it depends on, and Foundry
checks both the route and the fact against the durable record. An unsupported
jump or an unproven fact is refused with the current state, the requested state,
and the missing route or fact; a refused operation writes nothing.

Accepted transitions append a chained event to the canonical history and then
rebuild the derived `workflow-state.json` report from that accepted history. The
rebuilt report is one version 2 document:

```json
{
  "schemaVersion": 2,
  "runId": "RUN-EXAMPLE-001",
  "state": "reviewing",
  "checkpoint": null,
  "attempts": []
}
```

Version 1 records written by earlier Foundry versions remain readable and are
replaced by the version 2 rebuild on the next open or accepted transition. The
report is disposable: a missing, malformed, wrong-run, or disagreeing report is
regenerated atomically from verified history, and no report is ever used to
advance the run. `checkpoint` records the resume destination while a run is
`blocked` or `publish_failed`, and `resume` may return only to that recorded
checkpoint once its prerequisite is valid.

Same-state retries and control repairs append a distinct
`{ sequence, kind, role, state, reason }` attempt while keeping the workflow
state. They are recorded only while a stage is active; terminal and recoverable
states accept no attempt. A rejected operation appends nothing, and an exhausted
correction or retry budget never advances a state.

Cleanup progress is rebuilt from the latest cleanup event into
`cleanup-progress.json` in the run directory with outcome `succeeded`,
`warning`, or `failed`. The same rebuild verifies the workflow report against the
same history, so a `completed`, `completed_no_change`, `failed`, or `abandoned`
result is preserved rather than changed by cleanup.
