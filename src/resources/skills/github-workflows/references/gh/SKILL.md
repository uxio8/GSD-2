# `gh` reference for GitHub Workflows

Preferred helper:

```bash
node scripts/ci_monitor.cjs runs
```

Useful follow-ups:

```bash
node scripts/ci_monitor.cjs watch <run-id>
node scripts/ci_monitor.cjs fail-fast <run-id>
node scripts/ci_monitor.cjs log-failed <run-id>
node scripts/ci_monitor.cjs test-summary <run-id>
node scripts/ci_monitor.cjs check-actions .github/workflows/ci.yml
```

Use raw `gh` only when `ci_monitor` does not cover the case.
