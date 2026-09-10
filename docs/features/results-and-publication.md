# Results and decision publication

Foundry's normal deliverable is a local, validated task-branch commit plus a
human-readable handoff. GitHub publication is reserved for Reviewer decisions
that genuinely need a person.

## Normal result

A successful implementation is the exact commit recorded by Foundry, not an
uncommitted file set or a changed-file list reported by Coder. The handoff
contains:

- source and result commits;
- task branch and Git-derived changed files;
- accepted plan and criterion coverage;
- deterministic checks and optional Tester observations;
- findings, corrections, and limitations; and
- final Reviewer outcome.

For parallel work, the result is Lead Coder's accepted aggregate commit, with
objective contributions available through integration provenance. The handoff
must agree with the accepted-commit record and current verification report,
not infer a result from a worker artifact or a role-reported commit field.
Report a required Tester result separately from an explicit plan-authorized
Tester skip. Keep rejected attempts, discounted evidence, non-blocking
limitations, and cleanup warnings discoverable even after successful completion.

Reviewer approval completes the run locally. Foundry does not create a PR for
an ordinary approved result. Teams may consume the commit through a separate
integration process outside Foundry.

An already-satisfied request completes as `completed_no_change`, with no Coder
commit and no PR.

## When Foundry creates a PR

Foundry creates or reuses a draft GitHub PR only when Reviewer returns
`human_decision_required` for a reviewable implementation commit.

Before remote side effects, Foundry verifies:

1. the task branch is clean and points to the accepted result commit;
2. source and result ancestry match the run;
3. the publication remote equals the configured source remote;
4. the remote identifies the expected GitHub repository; and
5. no exact open PR already represents the task-head/source-base pair.

Foundry then non-force-pushes the exact task branch and creates or reuses one
draft PR. It never mutates an existing PR's draft state.

## PR contents

The draft PR explains:

- that human judgment, not routine review, is requested;
- the exact decision question and options;
- the Reviewer recommendation when available;
- source/result commits and acceptance criteria;
- checks, Tester observations, findings, and correction history;
- unresolved risks and limitations; and
- the Foundry run ID needed for inspection and recovery.

The PR must not imply approval, completion, or merge readiness.

## Publication outcomes

| Outcome                       | Durable state             | Meaning                                                    |
| ----------------------------- | ------------------------- | ---------------------------------------------------------- |
| Reviewer approved             | `completed`               | Local result is complete; no PR created                    |
| Exact draft PR created/reused | `human_decision_required` | Await the future explicit decision-reconciliation protocol |
| GitHub publication fails      | `publish_failed`          | Reconcile the same run; do not create another run or PR    |
| Remote is not eligible GitHub | `blocked`                 | Decision cannot be published through the required channel  |

Because PR creation has remote side effects, publication uses a durable
transaction journal. Recovery resumes from the recorded checkpoint and never
infers success from a branch or arbitrary PR alone.

## Deliberately deferred

Foundry does not yet define how a human answer on GitHub is authenticated,
structured, or applied back to the workflow. Until that contract exists:

- comments and approvals are not machine-readable decisions;
- closure or merge is not automatic acceptance;
- Foundry does not resume Coder based on free-form PR activity; and
- the run remains preserved with its PR URL and decision question.

Foundry never force-pushes, merges, approves, closes, deploys, or rewrites
history. See [recovery](recovery.md) for uncertain publication and
[inspection and reporting](inspection-and-reporting.md) for the handoff.
