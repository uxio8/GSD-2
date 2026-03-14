import test from 'node:test'
import assert from 'node:assert/strict'

import { compareSemver, isSupportedGlobalInstall, runUpdate } from '../update-cmd.ts'

test('compareSemver handles equal and newer versions', () => {
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0)
  assert.ok(compareSemver('1.2.4', '1.2.3') > 0)
  assert.ok(compareSemver('1.2.3', '1.3.0') < 0)
})

test('isSupportedGlobalInstall detects npm global installs', () => {
  assert.equal(
    isSupportedGlobalInstall('/usr/local/lib/node_modules/gsd-pi', '/usr/local'),
    true,
  )
  assert.equal(
    isSupportedGlobalInstall('/opt/homebrew/node_modules/gsd-pi/dist', '/opt/homebrew'),
    true,
  )
  assert.equal(
    isSupportedGlobalInstall('/Users/me/dev/GSD-2', '/usr/local'),
    false,
  )
})

test('runUpdate skips local checkouts without mutating anything', async () => {
  const stdout: string[] = []
  let execCalls = 0

  await runUpdate({
    packageRoot: '/Users/me/dev/GSD-2',
    npmGlobalPrefix: '/usr/local',
    currentVersion: '0.3.1',
    execFileSync: (() => {
      execCalls += 1
      throw new Error('should not execute npm')
    }) as any,
    stdout: { write: (chunk: string) => { stdout.push(chunk); return true } },
    stderr: { write: () => true },
  })

  assert.equal(execCalls, 0)
  assert.match(stdout.join(''), /Local or dev checkout detected/)
})

test('runUpdate reports already up to date for supported global install', async () => {
  const stdout: string[] = []
  const calls: Array<string[]> = []

  await runUpdate({
    packageRoot: '/usr/local/lib/node_modules/gsd-pi',
    npmGlobalPrefix: '/usr/local',
    currentVersion: '0.3.1',
    execFileSync: ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      if (args[0] === 'view') return '0.3.1\n'
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }) as any,
    stdout: { write: (chunk: string) => { stdout.push(chunk); return true } },
    stderr: { write: () => true },
  })

  assert.deepEqual(calls, [['npm', 'view', 'gsd-pi', 'version']])
  assert.match(stdout.join(''), /Already up to date/)
})

test('runUpdate installs latest package when a newer version exists', async () => {
  const calls: Array<string[]> = []

  await runUpdate({
    packageRoot: '/usr/local/lib/node_modules/gsd-pi',
    npmGlobalPrefix: '/usr/local',
    currentVersion: '0.3.1',
    execFileSync: ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      if (args[0] === 'view') return '0.3.5\n'
      if (args[0] === 'install') return ''
      throw new Error(`unexpected command: ${args.join(' ')}`)
    }) as any,
    stdout: { write: () => true },
    stderr: { write: () => true },
  })

  assert.deepEqual(calls, [
    ['npm', 'view', 'gsd-pi', 'version'],
    ['npm', 'install', '-g', 'gsd-pi@latest'],
  ])
})
