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
- final Reviewer outcome and any authenticated human decision.

For parallel work, the result is Lead Coder's accepted aggregate commit, with
objective contributions available through integration provenance. The handoff
must agree with the accepted-commit record and current verification report,
not infer a result from a worker artifact or a role-reported commit field.
Report a required Tester result separately from an explicit plan-authorized
Tester skip. Keep rejected attempts, discounted evidence, non-blocking
limitations, and cleanup warnings discoverable even after successful completion.

## Canonical handoff

At `completed` or `completed_no_change`, Foundry writes exactly one
`.agent/runs/<run-id>/handoff.json`. It is a derived report built only from
verified canonical history, so rebuilding it for the same history is
byte-identical and a `resume` of an already-settled run reconciles the same
document rather than creating a second one.

A change handoff names the frozen source and result commits, the task branch, the
Git-derived changed-file list, the accepted plan and its criterion coverage, the
current commit-bound verification checks, the required Tester observation or an
explicit skip or retained limitation, findings, correction and rejected-attempt
evidence, limitations, cleanup warnings, the Reviewer outcome and narrative, and
any recorded authenticated human decision. A no-change handoff explains why the
verified source already satisfies the request and records no Coder result commit
and no pull request.

Promised coverage that is unavailable is listed in `missingCoverage` and sets
`coverageComplete` false rather than presenting a sparse summary as complete.
The handoff is a report: editing it never changes workflow state.

Reviewer approval completes the run locally. Foundry does not create a PR for
an ordinary approved result. Teams may consume the commit through a separate
integration process outside Foundry.

An authenticated human `accept` decision also completes locally and retains the
decision evidence and unresolved risk in the handoff; it is never rewritten as
Reviewer approval.

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
5. whether one exact open draft PR already represents the
   task-head/source-base pair—or the same run's immediately prior published
   head after a human-directed correction—with no conflicting match.

Foundry then non-force-pushes the exact task branch and creates or reuses one
draft PR. It never mutates an existing PR's draft state.

An exact pair means the configured GitHub repository, task-head branch and
accepted result commit, and configured source-base branch. An existing open
draft PR with that pair is reused. After an authenticated `correct`, the same
run-owned PR may point at the immediately prior published commit; its journaled
non-force push must advance that commit to the new descendant before Foundry
refreshes the decision body. An existing non-draft PR, multiple matching PRs,
or any other head mismatch is an integrity ambiguity and enters
`human_recovery`; Foundry never changes or duplicates it.

The recorded source commit is frozen for the run. Normal forward movement of
the remote source branch is recorded and allowed only while it still contains
that commit. Rewritten or unrelated source history blocks publication. Foundry
does not automatically rebase, merge, or rerun the request against a newer
source.

## PR contents

The draft PR explains:

- that human judgment, not routine review, is requested;
- the exact decision question and options;
- the Reviewer recommendation when available;
- source/result commits and acceptance criteria;
- checks, Tester observations, findings, and correction history;
- unresolved risks and limitations; and
- the exact authenticated command for each labeled option; and
- the Foundry run ID needed for inspection and recovery.

The PR must not imply approval, completion, or merge readiness.

## Publication outcomes

| Outcome                       | Durable state             | Meaning                                                          |
| ----------------------------- | ------------------------- | ---------------------------------------------------------------- |
| Reviewer approved             | `completed`               | Local result is complete; no PR created                          |
| Authenticated `accept` option | `completed`               | Human accepted the recorded decision risk; draft PR remains open |
| Exact draft PR created/reused | `human_decision_required` | Await one authenticated option command                           |
| GitHub publication fails      | `publish_failed`          | Reconcile the same run; do not create another run or PR          |
| Remote is not eligible GitHub | `blocked`                 | Decision cannot be published through the required channel        |

Because PR creation has remote side effects, publication uses a durable
transaction journal. Recovery resumes from the recorded checkpoint and never
infers success from a branch or arbitrary PR alone.

Publication uses the GitHub HTTPS API with `GITHUB_TOKEN` supplied from the
process environment. The required repository permissions are Metadata read,
Contents write, and Pull requests write; no token value is persisted. `doctor`
checks repository identity and these capabilities when publication is
configured. Publication configuration may be `null`; normal runs still proceed,
but a later human-decision outcome blocks because no approved human channel is
available.

The token permissions technically allow more GitHub operations than Foundry
uses. The publication adapter exposes only repository identity lookup,
task-branch non-force push, exact-PR lookup, draft-PR creation, decision-comment
reading, collaborator-permission lookup, and owned draft-PR body refresh; merge,
close, approval, review submission, release, deployment, and arbitrary branch
mutation have no application service operation or CLI route.

## Applying a human decision

Foundry assigns a decision ID, an unpredictable 128-bit nonce, and stable option
IDs to the Reviewer's labeled `accept`, `correct`, or `abandon` actions. The
draft PR prints one exact command per option:

```text
/foundry decide <run-id> <decision-id> <option-id> <nonce>
```

On `resume`, Foundry reads issue comments created after its publication
checkpoint. A decision is valid only when the entire trimmed comment is one
displayed command, the author is a human GitHub user whose current repository
permission is `maintain` or `admin`, the PR is still open and draft, and its head
is the recorded result commit. The token needs Pull requests read (already
included by write) for comments and Metadata read for the collaborator
permission check.

Repeated commands selecting the same option are idempotent. Conflicting valid
options, changed PR identity/head, unverifiable author permission, or ambiguous
pagination enters `human_recovery`. Once a decision event records the comment
ID, author, body hash, permission snapshot, and selected option, later edits or
deletion do not undo it.

- `accept` completes the run with completion reason `human_decision`; the
  handoff makes clear that Reviewer did not approve the unresolved risk.
- `correct` returns to Coder once with the selected label and decision evidence,
  creates a new commit, and reruns every downstream gate. This
  human-directed correction does not consume an automatic correction round.
- `abandon` enters terminal `abandoned` and performs safe owned-resource
  cleanup.

If a later review needs another decision, Foundry updates the existing owned
draft PR body for the new exact head and decision, then waits for a new nonce.
It never creates a second PR for that run. A `resume` with no valid command
simply reports that the run is still awaiting a decision.

Free-form comments, review approvals, closure, merge, reactions, labels, and
branch activity are never decisions. Foundry does not close, approve, or merge
the decision PR after applying an option.

Foundry never force-pushes, merges, approves, closes, deploys, or rewrites
history. See [recovery](recovery.md) for uncertain publication and
[inspection and reporting](inspection-and-reporting.md) for the handoff.
