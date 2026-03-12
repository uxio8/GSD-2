import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const OPTIONAL_ENV_KEYS = [
  'BRAVE_API_KEY',
  'BRAVE_ANSWERS_KEY',
  'CONTEXT7_API_KEY',
  'JINA_API_KEY',
  'TAVILY_API_KEY',
  'GEMINI_API_KEY',
  'SLACK_BOT_TOKEN',
  'DISCORD_BOT_TOKEN',
] as const

type OptionalEnvKey = (typeof OPTIONAL_ENV_KEYS)[number]

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseEnvFile(filePath: string): Partial<Record<OptionalEnvKey, string>> {
  const values: Partial<Record<OptionalEnvKey, string>> = {}
  const content = readFileSync(filePath, 'utf8')

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line
    const eqIndex = normalized.indexOf('=')
    if (eqIndex <= 0) continue

    const key = normalized.slice(0, eqIndex).trim() as OptionalEnvKey
    if (!OPTIONAL_ENV_KEYS.includes(key)) continue

    const value = unquoteEnvValue(normalized.slice(eqIndex + 1))
    if (value) values[key] = value
  }

  return values
}

export function loadProjectOptionalEnvKeys(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): OptionalEnvKey[] {
  const merged: Partial<Record<OptionalEnvKey, string>> = {}

  for (const fileName of ['.env', '.env.local']) {
    const filePath = join(cwd, fileName)
    if (!existsSync(filePath)) continue
    Object.assign(merged, parseEnvFile(filePath))
  }

  const loaded: OptionalEnvKey[] = []
  for (const key of OPTIONAL_ENV_KEYS) {
    const value = merged[key]
    if (!env[key] && value) {
      env[key] = value
      loaded.push(key)
    }
  }

  return loaded
}
