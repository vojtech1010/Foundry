# Platform parity suites

These suites prove that the same observable workflow and safety rules hold on
Linux and Windows. They are the both-platform evidence required by
`docs/features/protocol-contracts.md` and run in the CI `parity` job on
`ubuntu-latest` and `windows-latest`.

- Spawn the real platform adapters (process spawning, owned process cleanup,
  Git provisioning, durable run history, repository locking, role-host
  launching) rather than fakes.
- Assert platform-correct behavior with `process.platform` switches for the few
  rules that legitimately differ: `PATHEXT`/case-folding/junction resolution and
  separator handling on Windows, symlinks and POSIX process groups elsewhere.
- Use `it.live` when a test observes a real child process over wall-clock time
  and `it.effect` (with `TestClock`) when only durable state is under test.
- Keep containment closed on both platforms; a Windows-specific rule must never
  widen what a role, a path, or a process may reach.

Run the family with `npx vitest run tests/parity`.
