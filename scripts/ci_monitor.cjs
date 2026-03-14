#!/usr/bin/env node

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const STATUS_ICONS = {
  success: '✅',
  failure: '❌',
  cancelled: '🚫',
  skipped: '⏭️',
  timed_out: '⏱️',
  in_progress: '▶️',
  queued: '⏳',
  completed: '🏁',
}

const MAX_BUFFER = 50 * 1024 * 1024

function readNumberOption(value, fallback) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseArgs(args) {
  const parsed = { command: null, positional: [], options: {} }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[index + 1]
      if (next && !next.startsWith('-')) {
        parsed.options[key] = next
        index++
      } else {
        parsed.options[key] = true
      }
      continue
    }
    if (arg.startsWith('-')) {
      const key = arg.slice(1)
      const next = args[index + 1]
      if (next && !next.startsWith('-')) {
        parsed.options[key] = next
        index++
      } else {
        parsed.options[key] = true
      }
      continue
    }
    if (!parsed.command) parsed.command = arg
    else parsed.positional.push(arg)
  }
  return parsed
}

function createGhClient(options = {}) {
  const ghBin = options.ghBin || process.env.CI_MONITOR_GH_BIN || 'gh'
  const cwd = options.cwd || process.cwd()
  let cachedRepo = options.repo || null

  function run(args, opts = {}) {
    const result = spawnSync(ghBin, args, {
      cwd: opts.cwd || cwd,
      encoding: 'utf-8',
      maxBuffer: opts.maxBuffer || MAX_BUFFER,
      env: process.env,
    })
    if (result.error) throw result.error
    if (result.status !== 0 && !opts.allowFailure) {
      throw new Error((result.stderr || `gh exited ${result.status}`).trim())
    }
    return result.stdout
  }

  function json(args, opts = {}) {
    const output = run(args, opts)
    return output.trim() ? JSON.parse(output) : null
  }

  function getRepo() {
    if (cachedRepo) return cachedRepo
    cachedRepo =
      process.env.GITHUB_REPOSITORY ||
      json(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner
    return cachedRepo
  }

  function runView(runId, fields = 'status,conclusion,jobs') {
    return json(['run', 'view', String(runId), '--repo', getRepo(), '--json', fields])
  }

  function runList(opts = {}) {
    const args = [
      'run',
      'list',
      '--repo',
      getRepo(),
      '--limit',
      String(opts.limit || 10),
      '--json',
      'databaseId,status,conclusion,headBranch,createdAt,displayTitle,event',
    ]
    if (opts.branch) args.push('--branch', opts.branch)
    return json(args)
  }

  function runLog(runId, extraArgs = []) {
    return run(['run', 'view', String(runId), '--repo', getRepo(), ...extraArgs], {
      maxBuffer: MAX_BUFFER,
    })
  }

  return { run, json, getRepo, runView, runList, runLog }
}

function iconFor(status, conclusion) {
  return STATUS_ICONS[conclusion || status] || '❓'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractTestSummary(logs) {
  const total = logs.match(/# tests[\s:]+(\d+)/i)?.[1]
  const passed = logs.match(/# pass[\s:]+(\d+)/i)?.[1]
  const failed = logs.match(/# fail[\s:]+(\d+)/i)?.[1]
  const failedCases = logs.match(/^not ok .+$/gm) || []
  return { total, passed, failed, failedCases }
}

function findFailedJobs(jobs) {
  return (jobs || []).filter((job) => job.conclusion === 'failure')
}

async function handleRuns(client, options, stdout) {
  const list = client.runList({
    branch: typeof options.branch === 'string' ? options.branch : undefined,
    limit: readNumberOption(options.limit, 15),
  })

  stdout.write(`Recent runs${options.branch ? ` for "${options.branch}"` : ''}:\n`)
  for (const run of list || []) {
    stdout.write(
      `${iconFor(run.status, run.conclusion)} ${String(run.databaseId).padEnd(10)} ${run.headBranch || ''} ${run.displayTitle || ''}\n`,
    )
  }
}

async function handleWatch(client, runId, options, stdout, stderr) {
  const intervalMs = Math.max(0, readNumberOption(options.interval, 10) * 1000)
  const seen = new Map()

  while (true) {
    const run = client.runView(runId)
    const runState = `${run.status}:${run.conclusion || ''}`
    if (seen.get('run') !== runState) {
      stdout.write(`${iconFor(run.status, run.conclusion)} Run: ${run.status}${run.conclusion ? ` -> ${run.conclusion}` : ''}\n`)
      seen.set('run', runState)
    }

    for (const job of run.jobs || []) {
      const jobState = `${job.status}:${job.conclusion || ''}`
      const key = `job:${job.id}`
      if (seen.get(key) !== jobState) {
        stdout.write(`  ${iconFor(job.status, job.conclusion)} ${job.name}: ${job.status}${job.conclusion ? ` -> ${job.conclusion}` : ''}\n`)
        seen.set(key, jobState)
      }
    }

    if (run.status === 'completed') {
      const success = run.conclusion === 'success'
      ;(success ? stdout : stderr).write(`Completed: ${run.conclusion}\n`)
      process.exit(success ? 0 : 1)
    }

    await sleep(intervalMs)
  }
}

async function handleFailFast(client, runId, options, stdout, stderr) {
  const intervalMs = Math.max(0, readNumberOption(options.interval, 10) * 1000)
  const announced = new Set()

  while (true) {
    const run = client.runView(runId)

    for (const job of run.jobs || []) {
      if (!announced.has(job.id)) {
        stdout.write(`${iconFor(job.status, job.conclusion)} ${job.name}: ${job.conclusion || job.status}\n`)
        announced.add(job.id)
      }
      if (job.conclusion === 'failure') {
        stderr.write(`Job failed: ${job.name}\n`)
        process.exit(1)
      }
    }

    if (run.status === 'completed') {
      const success = run.conclusion === 'success'
      ;(success ? stdout : stderr).write(`Run completed: ${run.conclusion}\n`)
      process.exit(success ? 0 : 1)
    }

    await sleep(intervalMs)
  }
}

function handleLogFailed(client, runId, options, stdout) {
  const lines = readNumberOption(options.lines, 200)
  const output = client.runLog(runId, ['--log-failed'])
  const sliced = output.split(/\r?\n/).slice(-lines).join('\n')
  stdout.write(`${sliced}\n`)
}

function handleTestSummary(client, runId, stdout) {
  const logs = client.runLog(runId, ['--log'])
  const summary = extractTestSummary(logs)
  if (summary.total) stdout.write(`Total tests: ${summary.total}\n`)
  if (summary.passed) stdout.write(`Passed: ${summary.passed}\n`)
  if (summary.failed) stdout.write(`Failed: ${summary.failed}\n`)
  if (summary.failedCases.length > 0) {
    stdout.write('Failed tests:\n')
    for (const line of summary.failedCases.slice(0, 15)) {
      stdout.write(`  ${line}\n`)
    }
  }
}

function handleCheckActions(filePath, client, stdout) {
  const workflowPath = filePath || path.join('.github', 'workflows', 'ci.yml')
  if (!fs.existsSync(workflowPath)) {
    throw new Error(`Workflow file not found: ${workflowPath}`)
  }

  const content = fs.readFileSync(workflowPath, 'utf-8')
  const actions = new Set()
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/uses:\s*['"]?([^'"\s]+)['"]?/)
    if (!match) continue
    const ref = match[1]
    if (ref.startsWith('./') || ref.startsWith('docker://')) continue
    actions.add(ref.split('@')[0])
  }

  for (const action of actions) {
    const [owner, repo] = action.split('/')
    if (!owner || !repo) continue
    try {
      const latest = client.json(['api', `repos/${owner}/${repo}/releases/latest`], { allowFailure: true })
      const tag = latest?.tag_name
      stdout.write(`${action}${tag ? ` latest=${tag}` : ''}\n`)
    } catch (error) {
      stdout.write(`${action} error=${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}

const HELP = `
GitHub Actions monitor

Commands:
  runs [--branch <name>] [--limit <n>]
  watch <run-id> [--interval <seconds>]
  fail-fast <run-id> [--interval <seconds>]
  log-failed <run-id> [--lines <n>]
  test-summary <run-id>
  check-actions [workflow-file]

Options:
  --repo, -R   Override owner/repo for gh commands
`

async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout
  const stderr = io.stderr || process.stderr
  const parsed = parseArgs(argv)

  if (!parsed.command || parsed.command === 'help' || parsed.command === '--help') {
    stdout.write(HELP)
    return
  }

  const repo = typeof parsed.options.repo === 'string'
    ? parsed.options.repo
    : typeof parsed.options.R === 'string'
      ? parsed.options.R
      : undefined
  const client = createGhClient({ repo })

  if (parsed.command === 'runs') {
    await handleRuns(client, parsed.options, stdout)
    return
  }

  if (parsed.command === 'watch') {
    if (!parsed.positional[0]) throw new Error('watch requires a run id')
    await handleWatch(client, parsed.positional[0], parsed.options, stdout, stderr)
    return
  }

  if (parsed.command === 'fail-fast') {
    if (!parsed.positional[0]) throw new Error('fail-fast requires a run id')
    await handleFailFast(client, parsed.positional[0], parsed.options, stdout, stderr)
    return
  }

  if (parsed.command === 'log-failed') {
    if (!parsed.positional[0]) throw new Error('log-failed requires a run id')
    handleLogFailed(client, parsed.positional[0], parsed.options, stdout)
    return
  }

  if (parsed.command === 'test-summary') {
    if (!parsed.positional[0]) throw new Error('test-summary requires a run id')
    handleTestSummary(client, parsed.positional[0], stdout)
    return
  }

  if (parsed.command === 'check-actions') {
    handleCheckActions(parsed.positional[0], client, stdout)
    return
  }

  throw new Error(`Unknown command: ${parsed.command}`)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}

module.exports = {
  createGhClient,
  extractTestSummary,
  findFailedJobs,
  main,
  parseArgs,
}
