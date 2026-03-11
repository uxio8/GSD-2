import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@mariozechner/pi-coding-agent'

export type CodexSpeedMode = 'standard' | 'fast'

export interface CodexSpeedPaths {
  globalSettingsPath: string
  projectSettingsPath: string
}

export interface CodexSpeedModelRef {
  provider: string
  id: string
}

interface OpenAICodexResponsesPayload {
  model: string
  input: unknown[]
  text: {
    verbosity: string
  }
  tool_choice: 'auto'
  parallel_tool_calls: true
  service_tier?: string
}

const ENV_KEYS = [
  'GSD_CODEX_SPEED',
  'GSD_CODEX_SERVICE_TIER',
  'OPENAI_CODEX_SPEED',
  'OPENAI_CODEX_SERVICE_TIER',
] as const

export function getCodexSpeedPaths(cwd: string = process.cwd()): CodexSpeedPaths {
  return {
    globalSettingsPath: join(getAgentDir(), 'settings.json'),
    projectSettingsPath: join(cwd, '.gsd', 'settings.json'),
  }
}

export function normalizeCodexSpeed(value: unknown): CodexSpeedMode | undefined {
  if (typeof value !== 'string') return undefined

  switch (value.trim().toLowerCase()) {
    case 'fast':
      return 'fast'
    case 'standard':
    case 'default':
    case 'auto':
      return 'standard'
    default:
      return undefined
  }
}

export function resolveCodexSpeed(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  paths: CodexSpeedPaths = getCodexSpeedPaths(cwd),
): CodexSpeedMode | undefined {
  for (const key of ENV_KEYS) {
    const resolved = normalizeCodexSpeed(env[key])
    if (resolved) return resolved
  }

  const projectResolved = readCodexSpeedFromSettingsFile(paths.projectSettingsPath)
  if (projectResolved) return projectResolved

  return readCodexSpeedFromSettingsFile(paths.globalSettingsPath)
}

export function shouldUseCodexFastMode(
  model: CodexSpeedModelRef | undefined,
  isOAuthCredential: boolean,
  speed: CodexSpeedMode | undefined,
): boolean {
  return speed === 'fast'
    && !!model
    && model.provider === 'openai-codex'
    && model.id.startsWith('gpt-5.4')
    && isOAuthCredential
}

export function applyCodexFastMode(
  payload: unknown,
  model: CodexSpeedModelRef | undefined,
  isOAuthCredential: boolean,
  speed: CodexSpeedMode | undefined,
): unknown {
  if (!shouldUseCodexFastMode(model, isOAuthCredential, speed)) {
    return payload
  }
  if (!isOpenAICodexResponsesPayload(payload)) {
    return payload
  }
  if (payload.service_tier === 'fast') {
    return payload
  }

  return {
    ...payload,
    service_tier: 'fast',
  }
}

function readCodexSpeedFromSettingsFile(path: string): CodexSpeedMode | undefined {
  if (!existsSync(path)) return undefined

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return readCodexSpeedFromSettings(parsed)
  } catch {
    return undefined
  }
}

function readCodexSpeedFromSettings(value: unknown): CodexSpeedMode | undefined {
  if (!isRecord(value)) return undefined

  const openaiCodex = isRecord(value.openaiCodex) ? value.openaiCodex : undefined

  return normalizeCodexSpeed(
    value.service_tier
      ?? value.openaiCodexServiceTier
      ?? value.codexSpeed
      ?? openaiCodex?.service_tier
      ?? openaiCodex?.speed,
  )
}

function isOpenAICodexResponsesPayload(payload: unknown): payload is OpenAICodexResponsesPayload {
  if (!isRecord(payload)) return false
  if (typeof payload.model !== 'string') return false
  if (!Array.isArray(payload.input)) return false
  if (!isRecord(payload.text) || typeof payload.text.verbosity !== 'string') return false
  if (payload.tool_choice !== 'auto') return false
  if (payload.parallel_tool_calls !== true) return false

  return true
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}
