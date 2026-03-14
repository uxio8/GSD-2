import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] ?? 'all'

function listTests(dir, predicate = () => true) {
  return readdirSync(resolve(projectRoot, dir))
    .filter((name) => /\.test\.(ts|mjs)$/.test(name))
    .filter(predicate)
    .sort()
    .map((name) => join(dir, name))
}

function runNodeTests(files) {
  if (files.length === 0) return
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      './src/resources/extensions/gsd/tests/resolve-ts.mjs',
      '--experimental-strip-types',
      '--test',
      ...files,
    ],
    {
      cwd: projectRoot,
      stdio: 'inherit',
    },
  )

  if ((result.status ?? 0) !== 0) {
    process.exit(result.status ?? 1)
  }
}

const unitFiles = [
  ...listTests('src/resources/extensions/gsd/tests'),
  ...listTests('src/tests', (name) => name !== 'app-smoke.test.ts'),
]
const integrationFiles = [join('src', 'tests', 'app-smoke.test.ts')]

if (mode === 'unit') {
  runNodeTests(unitFiles)
} else if (mode === 'integration') {
  runNodeTests(integrationFiles)
} else if (mode === 'all') {
  runNodeTests(unitFiles)
  runNodeTests(integrationFiles)
} else {
  process.stderr.write(`Unknown test mode: ${mode}\n`)
  process.exit(1)
}
