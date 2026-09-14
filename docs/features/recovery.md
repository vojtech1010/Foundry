# Recovery

Recovery continues a recorded Foundry run after interruption without blindly
repeating role prompts, commits, or remote publication.

## First response

Inspect the existing run before starting anything new:

```powershell
node dist/cli/index.js status --config .\.agent\foundry.config.json --run-id RUN-EXAMPLE-001
node dist/cli/index.js inspect --config .\.agent\foundry.config.json --run-id RUN-EXAMPLE-001 --json
node dist/cli/index.js resume --config .\.agent\foundry.config.json --run-id RUN-EXAMPLE-001 --json
```

Recover the existing run while its request and source revision remain valid.
Start a new run only when the desired request or source genuinely changed.

## Recovery dispositions

| Disposition        | Meaning                                                              | Action                                                      |
| ------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| `accept`           | A settled attempt or terminal transition was reconciled              | Continue automatic validation                               |
| `continue_waiting` | The owned operation is still active or unstable                      | Observe again later; do not duplicate it                    |
| `retry`            | No submission side effect occurred or a bounded retry is proven safe | Resume the automatic stage                                  |
| `blocked`          | Safe progress needs an operational fix                               | Preserve evidence and correct the prerequisite              |
| `human_recovery`   | Identity, Git, lock, journal, or submission evidence is ambiguous    | Stop; a person investigates integrity, not product approval |

Human recovery is not manual workflow mode. It is an exceptional safety stop
for situations that automation cannot reconcile honestly.

**Implemented:** A resume of a `blocked` run classifies the recorded checkpoint
from durable evidence before it advances. A settled attempt or already-durable
result reconciles as `accept`; an owned submission that is still in progress is
`continue_waiting`; a stage with no submission side effect is a proven-safe
`retry`; a missing or drifted prerequisite is `blocked`; and ambiguous identity,
Git, lock, journal, or submission evidence is a `human_recovery` stop that
leaves durable state unchanged. Each disposition is recorded as a
`recovery-recorded` event, and a `human_recovery` stop is reported with the same
blocked error envelope as a decision-integrity stop.

## Role recovery

Foundry persists the pre-submit turn baseline and submission state. After
submission begins, recovery reattaches to the same owned session and requires a
newer settled observation. It never resubmits the original prompt merely because
an output file is absent.

**Implemented:** A stage re-entered by a `resume` transition reuses the latest
recorded role attempt instead of allocating a new one, so `startOrResumeRoleTurn`
takes its settled-session fast path or observes the owned submission without
submitting again. Every other re-entry (a control retry, a correction, or a
retest) still allocates the next attempt.

The `foundry-role-host-v1` sequence is create, persist identity, submit with an
idempotency key, then observe. Recovery calls only `observe` until the adapter
proves the turn was never accepted or reports a newer settled result. The wire
contract and capability requirements are defined in
[protocol contracts](protocol-contracts.md#role-host-protocol).

A bounded same-session control repair may occur after a settled role turn. It
keeps the role-attempt identity and original Markdown narrative, records the
validation errors, narrative and pre-repair control hashes, repair prompt, and
new settled observation, then revalidates only the narrow control envelope. It
cannot rewrite the narrative or change project code, tests, Git state, or
application data. It is not a new implementation attempt and cannot fabricate
evidence for a failed check.

Empty narratives, malformed control output, session mismatch, sequence
regression, or ambiguous submission cannot be accepted as success. A repair
that fixes unknown fields can still fail semantic validation and require a
bounded retest.

Reconcile role-attempt identity with owned resource records: prompt hash,
conversation generation, pre-submit baseline, and observed sequence identify
the invocation; session/process/workspace and working-directory records identify
its runtime. Parallel workers have their own identities, not the top-level
Coder's session. Neither a reused pane nor an artifact at the expected path is
sufficient identity evidence.

## Git and lock recovery

Repository locks are lease-backed and identity-bound. `run` takes the lease
before it creates run storage, so a denial leaves no run files and reports a
`blocked` command result with the run ID. A confirmed dead owner may be
recovered automatically once the lease is expired. Live or indeterminate
ownership remains blocking; a PID alone does not prove identity.

Interrupted Coder files are evidence, not an accepted implementation. Foundry
accepts only a verified commit on the assigned branch and derives changes from
Git. Never edit `.agent`, worker branches, worktrees, journals, or role artifacts
to make recovery advance.

## Decision-publication recovery

Draft PR publication is idempotent and journaled:

1. verify the exact accepted commit and source ancestry;
2. record the pre-push checkpoint;
3. non-force-push the exact task branch;
4. find an exact task-head/source-base PR;
5. reuse it or create one draft PR; and
6. persist the URL before reporting `human_decision_required`.

If push or PR creation may have occurred, resume the same run. Do not create a
new run, branch, or PR. Uncertain remote side effects remain `publish_failed` or
`human_recovery` until the journal and GitHub state can be reconciled.

Recovery scans only for the exact authenticated option command in
[results and publication](results-and-publication.md#applying-a-human-decision).
With no valid command it continues waiting; it never infers a decision from
ordinary comments, approvals, closure, merge, reactions, labels, or branch
activity.

**Implemented:** A resume of a `publish_failed` run reconciles the checkpoint
journal with GitHub before leaving the state: it re-pushes the exact task branch
only when the push is not journaled, reuses or creates the one exact draft pair,
appends only the missing checkpoints in stage order, and records a
`publication-reconciled` event only after the exact draft URL is durable. An
irreconcilable ambiguity stays `publish_failed` with its evidence preserved, and
the reconciling adapter never creates a run, branch, or second pull request. A
resume of a published run with no valid decision command reports that the run is
still waiting.

## Abandonment and cleanup

A nonterminal run may be explicitly abandoned with a required reason. This
records the decision, stops owned resources where safe, and preserves evidence;
it does not approve, commit, publish, or erase history.

Successful abandonment transitions the workflow to terminal `abandoned` even
when some disposal remains pending or uncertain. Those cleanup facts remain
separate from the terminal reason.

The supported surface is `resume --run-id <id> --abandon --reason <text>`.
Abandonment is idempotent for the same run and reason; a different repeated
reason is appended as a new audit note without rerunning cleanup.

Result acceptance and resource disposal are separate outcomes. At the end of
every terminal run Foundry automatically disposes the resources it owns — the
application process, recorded role sessions, the run worktree, and any worker
worktrees — and records a cleanup-progress outcome independently of the terminal
workflow state. A completed run may still have pending/failed role shutdown,
uncertain harness ownership, or a worktree-removal warning. Preserve its accepted
result and report the cleanup problem; do not rerun implementation or assume
cleanup succeeded from the terminal workflow state. Reconcile ownership before
retrying resource cleanup.

Disposing an application process, role session, or worker worktree does not by
itself prove that a task branch was deleted. Preserve result access and durable
provenance independently of disposable execution resources.

Retention cleanup acts only on terminal, ownership-verified runs. Use
[inspection and reporting](inspection-and-reporting.md) to create a diagnostic
bundle before intervening in malformed state or uncertain ownership.
