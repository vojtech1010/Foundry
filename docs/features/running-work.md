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

1. **Provision source.** Fetch and verify the configured source branch, acquire
   the repository lease, and create run-owned storage and a worktree.
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

## Plan-controlled validation

The accepted, machine-validated plan records stable acceptance-criterion IDs,
affected path scopes, whether runtime validation is required, and the rationale
for that decision. These fields determine validation routing; a role's prose
claim or preference cannot silently enable or omit Tester.

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

| State                                                     | Meaning                               | Automatic action                                             |
| --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `planning`, `coding`, `verifying`, `testing`, `reviewing` | A stage is active                     | Continue within configured bounds                            |
| `correcting`                                              | Coder is addressing accepted findings | Reverify and rereview the new commit                         |
| `human_decision_required`                                 | Reviewer needs a product decision     | Create or reuse the exact draft PR and preserve the question |
| `completed`, `completed_no_change`                        | Successful terminal result            | Produce the final handoff and clean owned resources          |
| `blocked`, `failed`                                       | Safe automatic progress stopped       | Preserve evidence and use recovery; do not invent approval   |

Never infer success from files in `.agent`. A successful change requires a
validated state transition and Git-derived result commit. See
[inspection and reporting](inspection-and-reporting.md).
