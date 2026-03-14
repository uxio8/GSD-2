import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const NPM_PACKAGE = 'gsd-pi'

interface UpdateDeps {
  execFileSync?: typeof execFileSync
  packageRoot?: string
  currentVersion?: string
  npmGlobalPrefix?: string
  latestVersion?: string
  stdout?: Pick<NodeJS.WriteStream, 'write'>
  stderr?: Pick<NodeJS.WriteStream, 'write'>
}

function normalizePath(path: string): string {
  return resolve(path).replace(/[\\/]+$/, '')
}

function isSubpath(path: string, parent: string): boolean {
  const normalizedPath = normalizePath(path)
  const normalizedParent = normalizePath(parent)
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}${sep}`)
}

function readVersionFromPackage(packageRoot: string): string {
  const pkgPath = resolve(packageRoot, 'package.json')
  if (!existsSync(pkgPath)) return '0.0.0'
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function compareSemver(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const max = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < max; index++) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function getDefaultPackageRoot(): string {
  if (process.env.GSD_PACKAGE_ROOT) return normalizePath(process.env.GSD_PACKAGE_ROOT)
  return normalizePath(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
}

export function isSupportedGlobalInstall(packageRoot: string, npmGlobalPrefix: string): boolean {
  const root = normalizePath(packageRoot)
  const prefix = normalizePath(npmGlobalPrefix)
  const candidates = [
    resolve(prefix, 'lib', 'node_modules', NPM_PACKAGE),
    resolve(prefix, 'node_modules', NPM_PACKAGE),
  ]

  return candidates.some((candidate) => isSubpath(root, candidate))
}

export async function runUpdate(deps: UpdateDeps = {}): Promise<void> {
  const exec = deps.execFileSync ?? execFileSync
  const stdout = deps.stdout ?? process.stdout
  const stderr = deps.stderr ?? process.stderr
  const packageRoot = deps.packageRoot ?? getDefaultPackageRoot()
  const currentVersion = deps.currentVersion ?? process.env.GSD_VERSION ?? readVersionFromPackage(packageRoot)

  let npmGlobalPrefix = deps.npmGlobalPrefix
  if (!npmGlobalPrefix) {
    npmGlobalPrefix = exec('npm', ['prefix', '-g'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  }

  if (!isSupportedGlobalInstall(packageRoot, npmGlobalPrefix)) {
    stdout.write('Local or dev checkout detected. Update this repo from your normal local workflow.\n')
    return
  }

  stdout.write(`Current version: v${currentVersion}\n`)
  stdout.write('Checking npm registry...\n')

  let latestVersion = deps.latestVersion
  if (!latestVersion) {
    try {
      latestVersion = exec('npm', ['view', NPM_PACKAGE, 'version'], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    } catch {
      stderr.write('Failed to reach npm registry.\n')
      process.exitCode = 1
      return
    }
  }

  if (!latestVersion || compareSemver(latestVersion, currentVersion) <= 0) {
    stdout.write('Already up to date.\n')
    return
  }

  stdout.write(`Updating: v${currentVersion} -> v${latestVersion}\n`)

  try {
    exec('npm', ['install', '-g', `${NPM_PACKAGE}@latest`], { stdio: 'inherit' })
    stdout.write(`Updated to v${latestVersion}\n`)
  } catch {
    stderr.write(`Update failed. Try manually: npm install -g ${NPM_PACKAGE}@latest\n`)
    process.exitCode = 1
  }
}
