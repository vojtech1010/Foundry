# ADR-0007: Git Provenance and Run-Owned Worktrees and Branches

- Status: Accepted
- Date: 2026-09-08
- Relates to: `docs/features/running-work.md`,
  `docs/features/parallel-objectives.md`, `docs/features/recovery.md`

## Context

Coder output is untrusted prose plus files. Accepting a file list or an
uncommitted worktree as the result makes verification, review, and
recovery evaluate different things and lets interrupted work masquerade
as accepted.

## Decision

Git is the provenance system:

- Each run confirms one source revision, then works on run-owned
  branches (`foundry/<task-id>`, per-objective worker branches for
  parallel work) in run-owned worktrees. The source branch is never
  edited.
- A Coder result counts only as a verified commit on the assigned
  branch. Interrupted files are evidence, not implementation.
- Changed files, diffs, and ancestry are derived from Git. Coder-reported
  file lists are informational only.
- Corrections and lead integration always create new Foundry-recorded
  commits; downstream evidence from older commits is invalidated and the
  pipeline (checks, Tester when required, Reviewer) reruns.
- Remote publication is non-force-push of the exact recorded commit
  after verifying clean tree, source/result ancestry, remote identity,
  and GitHub repository match. History is never rewritten.
- Repository locks are lease-backed and identity-bound; a confirmed dead
  owner may be recovered, while live or indeterminate ownership blocks.
  A PID alone never proves identity.

## Consequences

- Verification, Tester, and Reviewer always evaluate the same commit.
- Worker commits are intermediate evidence; only the integrated commit
  is a candidate result.
- Git operations need deterministic wrappers with retry budgets distinct
  from correction budgets.

## Rejected alternatives

- Uncommitted file sets or Coder-reported lists as results:
  unverifiable and unrecoverable.
- Force-push or source-branch edits for convenience: destroys the audit
  trail recovery depends on.
- PID-file locking: unsafe under crashes and reuse.

## Enforcement / verification

- Integration tests against temporary Git repositories assert branch
  ownership, commit identity, ancestry checks, and derived diffs.
- Tests assert force-push is unreachable and source-branch mutation is
  rejected.
- Lock tests cover dead-owner recovery versus live/indeterminate
  blocking.
