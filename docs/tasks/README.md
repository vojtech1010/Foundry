# Implementation tasks

User-facing slices derived from [`docs/features`](../features). Each task is
one requirement a later agent can deliver without reading the whole product.

## How to use

- Implement in numbered order unless a task lists a later dependency.
  Earlier exceptions: [020](020-already-satisfied-request.md) after 021 and
  026, [029](029-decision-only-draft-pr.md) after 043, and
  [039](039-diagnostic-snapshot.md) after 042.
- For a walkable sequential run, do not wait until the end of the list.
  After 026 exists, implement [047](047-role-packets.md),
  [045](045-run-owns-first-pass.md),
  [046](046-automatic-routing-after-review.md), and
  [048](048-stand-in-role-host.md). Then
  [049](049-result-pr-on-approval.md) to publish a result pull request on
  ordinary approval.
- Stay inside the written requirement. Later numbers exist so this one can
  stay small.
- Size guesses include tests and nearby docs. If a change is heading past
  about 20 files or 500 lines, stop and split rather than absorbing the next
  task.
- Technical shape is intentionally omitted. Behavior lives in the linked
  feature pages.

These tasks assume the implemented baseline: the toolchain and architectural
boundaries exist, and autonomous orchestration is in place.

## Recommended order

| Task                                            | Requirement                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| [001](001-public-command-surface.md)            | One small public command set with consistent reports                   |
| [002](002-project-configuration.md)             | One closed project configuration                                       |
| [003](003-readiness-check.md)                   | Check that a project is ready                                          |
| [004](004-preview-run-locations.md)             | Preview where a run would work, without changing anything              |
| [005](005-commands-must-not-dirty-git.md)       | Project commands must not rewrite the repository                       |
| [006](006-request-and-run-identity.md)          | Start from one written request and unique IDs                          |
| [007](007-named-progress.md)                    | Named progress a person can understand                                 |
| [008](008-legal-progress-only.md)               | Work advances only along allowed routes                                |
| [009](009-trustworthy-run-history.md)           | A trustworthy history of what happened                                 |
| [010](010-status-from-history.md)               | Current status comes from that history                                 |
| [011](011-one-repository-owner.md)              | Only one owner may drive the target repository                         |
| [012](012-run-owned-workspace.md)               | A run uses its own workspace and leaves the checkout alone             |
| [013](013-frozen-guidance.md)                   | Project guidance is frozen for the run                                 |
| [014](014-role-conversations.md)                | Role work happens in a resumable conversation                          |
| [015](015-capable-role-host.md)                 | Refuse a live run if the role host cannot keep sessions or permissions |
| [016](016-role-permissions.md)                  | Each role may only do what its job allows                              |
| [017](017-bounded-plan.md)                      | Architect delivers a bounded plan and acceptance criteria              |
| [018](018-sequential-by-default.md)             | Unsafe split metadata means one sequential implementation              |
| [019](019-coder-commits-the-change.md)          | Only Coder changes project files; the result is a commit               |
| [020](020-already-satisfied-request.md)         | An already-satisfied request can finish with no code change            |
| [021](021-project-checks-on-commit.md)          | Run the project's own checks against the recorded commit               |
| [022](022-dirtying-command-is-a-violation.md)   | A check that rewrites tracked files is a violation                     |
| [023](023-live-testing-only-when-required.md)   | Live application testing happens only when the plan requires it        |
| [024](024-foundry-owns-the-application.md)      | Foundry prepares and stops the application                             |
| [025](025-tester-observes-without-mutation.md)  | Tester may observe but must not change application data                |
| [026](026-reviewer-outcomes.md)                 | Reviewer chooses from a small set of outcomes                          |
| [027](027-bounded-corrections.md)               | Actionable findings return to Coder as a bounded correction            |
| [028](028-repair-the-machine-decision.md)       | Repair a malformed machine decision without rewriting the report       |
| [029](029-decision-only-draft-pr.md)            | A product decision creates a draft PR that asks a person to choose     |
| [030](030-authenticated-decision-command.md)    | A waiting decision is resolved only by the exact authenticated command |
| [031](031-recover-publication-in-place.md)      | Interrupted publication is recovered in the same run                   |
| [032](032-status-at-a-glance.md)                | See current progress at a glance                                       |
| [033](033-inspect-evidence.md)                  | Inspect accepted evidence, failures, and open decisions                |
| [034](034-complete-handoff.md)                  | The final handoff matches the recorded result                          |
| [035](035-resume-without-repeating-work.md)     | Resume without repeating prompts, commits, or publication              |
| [036](036-abandon-with-a-reason.md)             | Abandon a run with a recorded reason                                   |
| [037](037-cleanup-keeps-the-result.md)          | Dispose owned resources without erasing the result                     |
| [038](038-confirmed-retention-cleanup.md)       | Delete old finished runs only with explicit confirmation               |
| [039](039-diagnostic-snapshot.md)               | Export a bounded diagnostic snapshot                                   |
| [040](040-parallel-independent-work.md)         | Independent plan parts may run in parallel                             |
| [041](041-integrate-before-review.md)           | Parallel work is integrated before checks and review                   |
| [042](042-bounded-redacted-evidence.md)         | Retained logs stay size-bounded and accidentally secret-free           |
| [043](043-publication-readiness.md)             | When publication is enabled, check readiness before a live run         |
| [044](044-linux-and-windows-parity.md)          | Linux and Windows operators get the same workflow and safety           |
| [045](045-run-owns-first-pass.md)               | `run` takes a request through first review without stage commands      |
| [046](046-automatic-routing-after-review.md)    | After Reviewer answers, Foundry routes the rest of the run             |
| [047](047-role-packets.md)                      | Each role sees previous reports and Foundry facts, intact              |
| [048](048-stand-in-role-host.md)                | A stand-in role host can walk the full workflow                        |
| [049](049-result-pr-on-approval.md)             | Ordinary approval publishes a result pull request                      |
| [050](050-checks-before-runtime.md)             | Project checks finish before the application is started                |
| [051](051-head-advance-invalidates-evidence.md) | Any new accepted result commit retires older checks and observations   |
| [052](052-captures-count-by-content.md)         | Captures count by content, not by filename or caption                  |

## Walkable sequential workflow

After 001–019, 021, 023, 026, and 045–048, an operator can start `run` and go
through Architect → Coder → checks → optional Tester skip → Reviewer →
completion using the stand-in host. Add 024–025 when live testing is required,
027 and 051 for corrections, 029–031 for a waiting human decision, and 049 to
publish a result pull request on ordinary approval.

## Intentionally later or excluded

- Reverse-engineering notes in [`run-history-evidence.md`](../features/run-history-evidence.md)
  are background. Tasks 049–052 promote only the must-have behaviors from that
  history (result PR after approval, checks before runtime, head-advance
  invalidation, content-addressed captures).
- There is no task for manual, pilot, shadow, or per-stage approval modes.
- There is no task for Tester data-mutation authority, a Quality Engineer
  role, or a mandatory screenshot matrix.
