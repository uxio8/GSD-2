import { DefaultResourceLoader } from '@mariozechner/pi-coding-agent'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolves to the bundled src/resources/ inside the npm package at runtime:
//   dist/resource-loader.js → .. → package root → src/resources/
const resourcesDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'resources')
const bundledExtensionsDir = join(resourcesDir, 'extensions')

function isExtensionFile(name: string): boolean {
  return name.endsWith('.ts') || name.endsWith('.js')
}

function resolveExtensionEntries(dir: string): string[] {
  const packageJsonPath = join(dir, 'package.json')
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
        pi?: { extensions?: unknown }
      }
      if (Array.isArray(pkg.pi?.extensions)) {
        const declared = pkg.pi.extensions
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => resolve(dir, entry))
          .filter((entry) => existsSync(entry))
        if (declared.length > 0) return declared
      }
    } catch {
      // Fall back to index discovery when the manifest is absent or invalid.
    }
  }

  const indexTs = join(dir, 'index.ts')
  if (existsSync(indexTs)) return [indexTs]

  const indexJs = join(dir, 'index.js')
  if (existsSync(indexJs)) return [indexJs]

  return []
}

export function discoverExtensionEntryPaths(extensionsDir: string): string[] {
  if (!existsSync(extensionsDir)) return []

  const discovered: string[] = []
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    const entryPath = join(extensionsDir, entry.name)

    if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
      discovered.push(entryPath)
      continue
    }

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      discovered.push(...resolveExtensionEntries(entryPath))
    }
  }

  return discovered
}

function getExtensionKey(entryPath: string, extensionsDir: string): string {
  const relPath = relative(extensionsDir, entryPath)
  return relPath.split(/[\\/]/)[0]
}

function mergeUniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const path of paths) {
    const normalized = resolve(path)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    merged.push(path)
  }
  return merged
}

export interface BuildResourceLoaderOptions {
  additionalExtensionPaths?: string[]
  appendSystemPrompt?: string
}

/**
 * Syncs all bundled resources to agentDir (~/.gsd/agent/) on every launch.
 *
 * - extensions/ → ~/.gsd/agent/extensions/   (always overwrite — ensures updates ship on next launch)
 * - agents/     → ~/.gsd/agent/agents/        (always overwrite)
 * - AGENTS.md   → ~/.gsd/agent/AGENTS.md      (always overwrite)
 * - GSD-WORKFLOW.md is read directly from bundled path via GSD_WORKFLOW_PATH env var
 *
 * Always-overwrite ensures `npm update -g @glittercowboy/gsd` takes effect immediately.
 * User customizations should go in ~/.gsd/agent/extensions/ subdirs with unique names,
 * not by editing the gsd-managed files.
 *
 * Inspectable: `ls ~/.gsd/agent/extensions/`
 */
export function initResources(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true })

  // Sync extensions — always overwrite so updates land on next launch
  const destExtensions = join(agentDir, 'extensions')
  cpSync(bundledExtensionsDir, destExtensions, { recursive: true, force: true })

  // Sync agents
  const destAgents = join(agentDir, 'agents')
  const srcAgents = join(resourcesDir, 'agents')
  if (existsSync(srcAgents)) {
    cpSync(srcAgents, destAgents, { recursive: true, force: true })
  }

  // Sync skills — always overwrite so updates land on next launch
  const destSkills = join(agentDir, 'skills')
  const srcSkills = join(resourcesDir, 'skills')
  if (existsSync(srcSkills)) {
    cpSync(srcSkills, destSkills, { recursive: true, force: true })
  }

  // Sync AGENTS.md
  const srcAgentsMd = join(resourcesDir, 'AGENTS.md')
  const destAgentsMd = join(agentDir, 'AGENTS.md')
  if (existsSync(srcAgentsMd)) {
    writeFileSync(destAgentsMd, readFileSync(srcAgentsMd))
  }
}

/**
 * Constructs a DefaultResourceLoader that keeps bundled resources in the
 * GSD agent dir and layers in external Pi extensions plus any caller-supplied
 * extension paths without duplicating bundled ones.
 */
export function buildResourceLoader(
  agentDir: string,
  options: BuildResourceLoaderOptions = {},
): DefaultResourceLoader {
  const piExtensionsDir = join(homedir(), '.pi', 'agent', 'extensions')
  const bundledKeys = new Set(
    discoverExtensionEntryPaths(bundledExtensionsDir)
      .map((entryPath) => getExtensionKey(entryPath, bundledExtensionsDir)),
  )
  const piExtensionPaths = discoverExtensionEntryPaths(piExtensionsDir).filter(
    (entryPath) => !bundledKeys.has(getExtensionKey(entryPath, piExtensionsDir)),
  )
  const additionalExtensionPaths = mergeUniquePaths([
    ...piExtensionPaths,
    ...(options.additionalExtensionPaths ?? []),
  ])

  return new DefaultResourceLoader({
    agentDir,
    additionalExtensionPaths,
    appendSystemPrompt: options.appendSystemPrompt,
  })
}
