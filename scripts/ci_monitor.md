# `ci_monitor`

Lightweight helper around `gh` for GitHub Actions runs.

Examples:

```bash
node scripts/ci_monitor.cjs runs --branch main
node scripts/ci_monitor.cjs watch 123456789 --interval 5
node scripts/ci_monitor.cjs fail-fast 123456789 --interval 5
node scripts/ci_monitor.cjs log-failed 123456789 --lines 150
node scripts/ci_monitor.cjs test-summary 123456789
node scripts/ci_monitor.cjs check-actions .github/workflows/ci.yml
```

Notes:

- Requires GitHub CLI (`gh`) authenticated for the target repo.
- `--repo owner/name` overrides the repo instead of using the current checkout.
- Use `CI_MONITOR_GH_BIN=/path/to/gh` in tests or custom environments.
