#!/usr/bin/env node

import { exec as execCb } from 'child_process'
import { createRequire } from 'module'
import os from 'os'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const pkg = require(resolve(__dirname, '..', 'package.json'))
const cwd = resolve(__dirname, '..')

function run(cmd, options = {}) {
  return new Promise((resolveRun) => {
    execCb(cmd, { cwd, ...options }, (error, stdout, stderr) => {
      resolveRun({ ok: !error, stdout, stderr, error })
    })
  })
}

process.stdout.write = process.stderr.write.bind(process.stderr)

const cyan = '\x1b[36m'
const dim = '\x1b[2m'
const reset = '\x1b[0m'

const banner =
  '\n' +
  cyan +
  '   ██████╗ ███████╗██████╗ \n' +
  '  ██╔════╝ ██╔════╝██╔══██╗\n' +
  '  ██║  ███╗███████╗██║  ██║\n' +
  '  ██║   ██║╚════██║██║  ██║\n' +
  '  ╚██████╔╝███████║██████╔╝\n' +
  '   ╚═════╝ ╚══════╝╚═════╝ ' +
  reset + '\n' +
  '\n' +
  `  Get Shit Done ${dim}v${pkg.version}${reset}\n`

;(async () => {
  process.stderr.write(banner)

  let p
  let pc

  try {
    p = await import('@clack/prompts')
    pc = (await import('picocolors')).default
  } catch {
    process.stderr.write('  Run gsd to get started.\n\n')
    await run('npx patch-package')
    await run('npx playwright install chromium')
    return
  }

  p.intro('Setup')

  const results = []
  const s = p.spinner()

  s.start('Applying patches…')
  const patchResult = await run('npx patch-package')
  if (patchResult.ok) {
    s.stop('Patches applied')
    results.push({ label: 'Patches applied', ok: true })
  } else {
    s.stop(pc.yellow('Patches — skipped (non-fatal)'))
    results.push({
      label: 'Patches skipped — run ' + pc.cyan('npx patch-package') + ' manually',
      ok: false,
    })
  }

  s.start('Setting up browser tools…')
  const pwResult = await run('npx playwright install chromium')
  if (pwResult.ok) {
    s.stop('Browser tools ready')
    results.push({ label: 'Browser tools ready', ok: true })
  } else {
    const output = `${pwResult.stdout ?? ''}${pwResult.stderr ?? ''}`
    if (os.platform() === 'linux' && output.includes('Host system is missing dependencies to run browsers.')) {
      s.stop(pc.yellow('Browser downloaded, missing Linux deps'))
      results.push({
        label: 'Run ' + pc.cyan('sudo npx playwright install-deps chromium') + ' to finish setup',
        ok: false,
      })
    } else {
      s.stop(pc.yellow('Browser tools — skipped (non-fatal)'))
      results.push({
        label: 'Browser tools unavailable — run ' + pc.cyan('npx playwright install chromium'),
        ok: false,
      })
    }
  }

  const lines = results.map((r) => (r.ok ? pc.green('✓') : pc.yellow('⚠')) + ' ' + r.label)
  lines.push('')
  lines.push('Run ' + pc.cyan('gsd') + ' to get started.')

  p.note(lines.join('\n'), 'Installed')
  p.outro(pc.green('Done!'))
})()
