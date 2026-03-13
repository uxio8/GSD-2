import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AuthCredential, AuthStorage } from '@mariozechner/pi-coding-agent'

const PI_AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json')
const PI_SETTINGS_PATH = join(homedir(), '.pi', 'agent', 'settings.json')

const LLM_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'github-copilot',
  'openai-codex',
  'google-gemini-cli',
  'google-antigravity',
  'google',
  'groq',
  'xai',
  'openrouter',
  'mistral',
]

export function migratePiCredentials(authStorage: AuthStorage): boolean {
  try {
    const hasLlm = LLM_PROVIDER_IDS.some((id) => authStorage.hasAuth(id))
    if (hasLlm) return false

    if (!existsSync(PI_AUTH_PATH)) return false

    const raw = readFileSync(PI_AUTH_PATH, 'utf-8')
    const piData = JSON.parse(raw) as Record<string, AuthCredential>

    let migratedLlm = false
    for (const [providerId, credential] of Object.entries(piData)) {
      if (authStorage.has(providerId)) continue
      authStorage.set(providerId, credential)
      const isLlm = LLM_PROVIDER_IDS.includes(providerId)
      if (isLlm) migratedLlm = true
      process.stderr.write(`[gsd] Migrated ${isLlm ? 'LLM provider' : 'credential'}: ${providerId} (from Pi)\n`)
    }

    return migratedLlm
  } catch {
    return false
  }
}

export function getPiDefaultModelAndProvider(): { provider: string; model: string } | null {
  try {
    if (!existsSync(PI_SETTINGS_PATH)) return null

    const raw = readFileSync(PI_SETTINGS_PATH, 'utf-8')
    const data = JSON.parse(raw) as { defaultProvider?: unknown; defaultModel?: unknown }
    if (typeof data.defaultProvider !== 'string' || typeof data.defaultModel !== 'string') {
      return null
    }

    return {
      provider: data.defaultProvider,
      model: data.defaultModel,
    }
  } catch {
    return null
  }
}
