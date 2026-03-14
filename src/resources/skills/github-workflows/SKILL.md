# GitHub Workflows

Use this skill when the task is about GitHub Actions runs, workflow failures, flaky CI, or action version drift.

## Default approach

1. Prefer `node scripts/ci_monitor.cjs runs` to inspect recent runs.
2. Use `node scripts/ci_monitor.cjs fail-fast <run-id>` or `watch <run-id>` while waiting.
3. Use `node scripts/ci_monitor.cjs log-failed <run-id>` to inspect failed jobs quickly.
4. Use `node scripts/ci_monitor.cjs test-summary <run-id>` when the failure is in the test job.
5. Use `node scripts/ci_monitor.cjs check-actions [workflow-file]` before editing workflow versions.

## Rules

- Prefer `ci_monitor` over ad hoc `gh run ...` command strings.
- Keep conclusions concrete: failing workflow, failing job, failing test, or action version drift.
- When editing workflows, preserve the existing release/publish pipeline unless the task explicitly asks to change it.

See [gh reference](./references/gh/SKILL.md) for command examples.
