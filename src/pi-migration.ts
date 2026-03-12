import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AuthCredential, AuthStorage } from '@mariozechner/pi-coding-agent'

const PI_AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json')

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
    const existing = authStorage.list()
    const hasLlm = existing.some((id) => LLM_PROVIDER_IDS.includes(id))
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
