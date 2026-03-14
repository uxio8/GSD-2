import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { extractTestSummary, parseArgs } = require('../../scripts/ci_monitor.cjs')

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))

function writeFakeGh(tmp: string, fixture: Record<string, unknown>): string {
  const fixturePath = join(tmp, 'fixture.json')
  const statePath = join(tmp, 'state.json')
  const ghPath = join(tmp, 'gh')
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2))
  writeFileSync(statePath, JSON.stringify({}))

  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, 'utf8'));
const statePath = process.env.GH_STATE;
function loadState() {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}
function nextValue(key, fallback) {
  const state = loadState();
  const sequence = fixture[key];
  if (!Array.isArray(sequence)) return fallback;
  const index = state[key] || 0;
  state[key] = index + 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
  return sequence[Math.min(index, sequence.length - 1)];
}
const args = process.argv.slice(2);
if (args[0] === 'repo' && args[1] === 'view') {
  console.log(JSON.stringify({ nameWithOwner: fixture.repo || 'owner/repo' }));
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'list') {
  console.log(JSON.stringify(fixture.runList || []));
  process.exit(0);
}
if (args[0] === 'run' && args[1] === 'view') {
  const runId = args[2];
  if (args.includes('--json')) {
    const fields = args[args.indexOf('--json') + 1];
    const key = 'runView:' + runId + ':' + fields;
    const value = nextValue(key, fixture.runView || { status: 'completed', conclusion: 'success', jobs: [] });
    console.log(JSON.stringify(value));
    process.exit(0);
  }
  if (args.includes('--log-failed')) {
    process.stdout.write(String(fixture.logFailed || ''));
    process.exit(0);
  }
  if (args.includes('--log')) {
    process.stdout.write(String(fixture.log || ''));
    process.exit(0);
  }
}
if (args[0] === 'api') {
  const key = args[1];
  console.log(JSON.stringify((fixture.api && fixture.api[key]) || {}));
  process.exit(0);
}
console.error('unexpected gh call', args.join(' '));
process.exit(1);
`,
    'utf-8',
  )
  chmodSync(ghPath, 0o755)
  return ghPath
}

function runCiMonitor(tmp: string, ghPath: string, args: string[]) {
  return spawnSync(process.execPath, ['scripts/ci_monitor.cjs', ...args], {
    cwd: projectRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      CI_MONITOR_GH_BIN: ghPath,
      GH_FIXTURE: join(tmp, 'fixture.json'),
      GH_STATE: join(tmp, 'state.json'),
    },
  })
}

test('parseArgs handles commands, positional args, and options', () => {
  const parsed = parseArgs(['watch', '123', '--interval', '5', '--repo', 'owner/repo'])
  assert.equal(parsed.command, 'watch')
  assert.deepEqual(parsed.positional, ['123'])
  assert.equal(parsed.options.interval, '5')
  assert.equal(parsed.options.repo, 'owner/repo')
})

test('extractTestSummary parses node:test output', () => {
  const summary = extractTestSummary([
    '# tests 12',
    '# pass 11',
    '# fail 1',
    'not ok 3 - should handle retry',
  ].join('\n'))

  assert.equal(summary.total, '12')
  assert.equal(summary.passed, '11')
  assert.equal(summary.failed, '1')
  assert.deepEqual(summary.failedCases, ['not ok 3 - should handle retry'])
})

test('ci_monitor supports runs, watch, fail-fast, log-failed, and test-summary', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gsd-ci-monitor-'))

  try {
    const ghPath = writeFakeGh(tmp, {
      repo: 'owner/repo',
      runList: [
        {
          databaseId: 101,
          status: 'completed',
          conclusion: 'success',
          headBranch: 'main',
          createdAt: '2026-03-14T09:00:00.000Z',
          displayTitle: 'CI',
          event: 'push',
        },
      ],
      'runView:101:status,conclusion,jobs': [
        { status: 'in_progress', conclusion: null, jobs: [{ id: 1, name: 'build', status: 'in_progress', conclusion: null }] },
        { status: 'completed', conclusion: 'success', jobs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] },
      ],
      'runView:202:status,conclusion,jobs': [
        { status: 'in_progress', conclusion: null, jobs: [{ id: 2, name: 'tests', status: 'in_progress', conclusion: null }] },
        { status: 'completed', conclusion: 'failure', jobs: [{ id: 2, name: 'tests', status: 'completed', conclusion: 'failure' }] },
      ],
      logFailed: 'tests failed on line 42',
      log: '# tests 8\n# pass 7\n# fail 1\nnot ok 4 - should monitor failures\n',
    })

    const runs = runCiMonitor(tmp, ghPath, ['runs', '--branch', 'main'])
    assert.equal(runs.status, 0)
    assert.match(runs.stdout, /Recent runs/)
    assert.match(runs.stdout, /101/)

    const watch = runCiMonitor(tmp, ghPath, ['watch', '101', '--interval', '0'])
    assert.equal(watch.status, 0)
    assert.match(watch.stdout, /Completed: success/)

    const failFast = runCiMonitor(tmp, ghPath, ['fail-fast', '202', '--interval', '0'])
    assert.equal(failFast.status, 1)
    assert.match(failFast.stderr, /Job failed: tests/)

    const failed = runCiMonitor(tmp, ghPath, ['log-failed', '202', '--lines', '20'])
    assert.equal(failed.status, 0)
    assert.match(failed.stdout, /tests failed on line 42/)

    const summary = runCiMonitor(tmp, ghPath, ['test-summary', '202'])
    assert.equal(summary.status, 0)
    assert.match(summary.stdout, /Total tests: 8/)
    assert.match(summary.stdout, /Failed: 1/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
