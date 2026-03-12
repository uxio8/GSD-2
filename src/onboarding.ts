import { exec } from 'node:child_process'
import type { AuthStorage } from '@mariozechner/pi-coding-agent'
import { renderLogo } from './logo.js'

interface ToolKeyConfig {
  provider: string
  envVar: string
  label: string
  hint: string
}

type ClackModule = typeof import('@clack/prompts')
type PicoModule = {
  cyan: (s: string) => string
  green: (s: string) => string
  yellow: (s: string) => string
  dim: (s: string) => string
  bold: (s: string) => string
}

const TOOL_KEYS: ToolKeyConfig[] = [
  { provider: 'brave', envVar: 'BRAVE_API_KEY', label: 'Brave Search', hint: 'web search + search_and_read' },
  { provider: 'brave_answers', envVar: 'BRAVE_ANSWERS_KEY', label: 'Brave Answers', hint: 'AI-summarised search answers' },
  { provider: 'context7', envVar: 'CONTEXT7_API_KEY', label: 'Context7', hint: 'up-to-date library docs' },
  { provider: 'jina', envVar: 'JINA_API_KEY', label: 'Jina AI', hint: 'clean web page extraction' },
  { provider: 'tavily', envVar: 'TAVILY_API_KEY', label: 'Tavily Search', hint: 'alternative search backend' },
]

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
] as const

const API_KEY_PREFIXES: Record<string, string[]> = {
  anthropic: ['sk-ant-'],
  openai: ['sk-'],
}

const OTHER_PROVIDERS = [
  { value: 'google', label: 'Google (Gemini)' },
  { value: 'groq', label: 'Groq' },
  { value: 'xai', label: 'xAI (Grok)' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'mistral', label: 'Mistral' },
]

async function loadClack(): Promise<ClackModule> {
  return await import('@clack/prompts')
}

async function loadPico(): Promise<PicoModule> {
  const mod = await import('picocolors')
  return (mod.default ?? mod) as PicoModule
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  exec(`${cmd} "${url}"`, () => {})
}

export function shouldRunOnboarding(authStorage: AuthStorage): boolean {
  if (!process.stdin.isTTY) return false
  return !authStorage.list().some((provider) => LLM_PROVIDER_IDS.includes(provider as (typeof LLM_PROVIDER_IDS)[number]))
}

export async function runOnboarding(authStorage: AuthStorage): Promise<void> {
  let p: ClackModule
  let pc: PicoModule

  try {
    ;[p, pc] = await Promise.all([loadClack(), loadPico()])
  } catch (error) {
    process.stderr.write(`[gsd] Onboarding wizard unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
    return
  }

  process.stderr.write(renderLogo(pc.cyan))
  p.intro(pc.bold("Welcome to GSD - let's get you set up"))

  let llmConfigured = false
  try {
    llmConfigured = await runLlmStep(p, pc, authStorage)
  } catch (error) {
    if (p.isCancel(error)) {
      p.cancel('Setup cancelled - you can run /login inside GSD later.')
      return
    }
    p.log.warn(`LLM setup failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  let toolKeyCount = 0
  try {
    toolKeyCount = await runToolKeysStep(p, pc, authStorage)
  } catch (error) {
    if (p.isCancel(error)) {
      p.cancel('Setup cancelled.')
      return
    }
    p.log.warn(`Tool key setup failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const summaryLines: string[] = []
  if (llmConfigured) {
    const authed = authStorage.list().filter((id) => LLM_PROVIDER_IDS.includes(id as (typeof LLM_PROVIDER_IDS)[number]))
    summaryLines.push(`${pc.green('✓')} LLM provider: ${authed[0] ?? 'configured'}`)
  } else {
    summaryLines.push(`${pc.yellow('↷')} LLM provider: skipped - use /login inside GSD`)
  }

  if (toolKeyCount > 0) {
    summaryLines.push(`${pc.green('✓')} ${toolKeyCount} tool key${toolKeyCount > 1 ? 's' : ''} saved`)
  } else {
    summaryLines.push(`${pc.dim('↷')} Tool keys: none configured`)
  }

  p.note(summaryLines.join('\n'), 'Setup complete')
  p.outro(pc.dim('Launching GSD...'))
}

async function runLlmStep(p: ClackModule, pc: PicoModule, authStorage: AuthStorage): Promise<boolean> {
  const oauthProviders = authStorage.getOAuthProviders()
  const oauthMap = new Map(oauthProviders.map((provider) => [provider.id, provider]))

  const choice = await p.select({
    message: 'Choose your LLM provider',
    options: [
      { value: 'anthropic-oauth', label: 'Anthropic - Claude (OAuth login)', hint: 'recommended' },
      { value: 'anthropic-api-key', label: 'Anthropic - Claude (API key)' },
      { value: 'openai-api-key', label: 'OpenAI (API key)' },
      { value: 'github-copilot-oauth', label: 'GitHub Copilot (OAuth login)' },
      { value: 'openai-codex-oauth', label: 'ChatGPT Plus/Pro - Codex (OAuth login)' },
      { value: 'google-gemini-cli-oauth', label: 'Google Gemini CLI (OAuth login)' },
      { value: 'google-antigravity-oauth', label: 'Antigravity (OAuth login)' },
      { value: 'other-api-key', label: 'Other provider (API key)' },
      { value: 'skip', label: 'Skip for now', hint: 'use /login later' },
    ],
  })

  if (p.isCancel(choice) || choice === 'skip') return false

  if (choice === 'anthropic-oauth') return runOAuthFlow(p, pc, authStorage, 'anthropic', oauthMap)
  if (choice === 'github-copilot-oauth') return runOAuthFlow(p, pc, authStorage, 'github-copilot', oauthMap)
  if (choice === 'openai-codex-oauth') return runOAuthFlow(p, pc, authStorage, 'openai-codex', oauthMap)
  if (choice === 'google-gemini-cli-oauth') return runOAuthFlow(p, pc, authStorage, 'google-gemini-cli', oauthMap)
  if (choice === 'google-antigravity-oauth') return runOAuthFlow(p, pc, authStorage, 'google-antigravity', oauthMap)
  if (choice === 'anthropic-api-key') return runApiKeyFlow(p, pc, authStorage, 'anthropic', 'Anthropic')
  if (choice === 'openai-api-key') return runApiKeyFlow(p, pc, authStorage, 'openai', 'OpenAI')
  return runOtherProviderFlow(p, pc, authStorage)
}

async function runOAuthFlow(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
  providerId: string,
  oauthMap: Map<string, { id: string; name?: string; usesCallbackServer?: boolean }>,
): Promise<boolean> {
  const providerInfo = oauthMap.get(providerId)
  const providerName = providerInfo?.name ?? providerId
  const usesCallbackServer = providerInfo?.usesCallbackServer ?? false
  const spinner = p.spinner()
  spinner.start(`Authenticating with ${providerName}...`)

  try {
    await authStorage.login(providerId as any, {
      onAuth: (info: { url: string; instructions?: string }) => {
        spinner.stop(`Opening browser for ${providerName}`)
        openBrowser(info.url)
        p.log.info(`${pc.dim('URL:')} ${pc.cyan(info.url)}`)
        if (info.instructions) p.log.info(pc.yellow(info.instructions))
      },
      onPrompt: async (prompt: { message: string; placeholder?: string }) => {
        const result = await p.text({
          message: prompt.message,
          placeholder: prompt.placeholder,
        })
        return p.isCancel(result) ? '' : String(result)
      },
      onProgress: (message: string) => {
        p.log.step(pc.dim(message))
      },
      onManualCodeInput: usesCallbackServer
        ? async () => {
            const result = await p.text({
              message: 'Paste the redirect URL from your browser:',
              placeholder: 'http://localhost:...',
            })
            return p.isCancel(result) ? '' : String(result)
          }
        : undefined,
    } as any)

    p.log.success(`Authenticated with ${pc.green(providerName)}`)
    return true
  } catch (error) {
    spinner.stop(`${providerName} authentication failed`)
    p.log.warn(`OAuth error: ${error instanceof Error ? error.message : String(error)}`)
    const retry = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'retry', label: 'Try again' },
        { value: 'skip', label: 'Skip - configure later with /login' },
      ],
    })
    if (p.isCancel(retry) || retry === 'skip') return false
    return runOAuthFlow(p, pc, authStorage, providerId, oauthMap)
  }
}

async function runApiKeyFlow(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
  providerId: string,
  providerLabel: string,
): Promise<boolean> {
  const key = await p.password({
    message: `Paste your ${providerLabel} API key:`,
    mask: '●',
  })

  if (p.isCancel(key) || !key) return false
  const trimmed = String(key).trim()
  if (!trimmed) return false

  const expectedPrefixes = API_KEY_PREFIXES[providerId]
  if (expectedPrefixes && !expectedPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
    p.log.warn(`Key doesn't start with expected prefix (${expectedPrefixes.join(' or ')}). Saving anyway.`)
  }

  authStorage.set(providerId, { type: 'api_key', key: trimmed })
  p.log.success(`API key saved for ${pc.green(providerLabel)}`)
  return true
}

async function runOtherProviderFlow(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
): Promise<boolean> {
  const provider = await p.select({
    message: 'Select provider',
    options: OTHER_PROVIDERS.map((option) => ({ value: option.value, label: option.label })),
  })

  if (p.isCancel(provider)) return false
  const label = OTHER_PROVIDERS.find((option) => option.value === provider)?.label ?? String(provider)
  return runApiKeyFlow(p, pc, authStorage, String(provider), label)
}

async function runToolKeysStep(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
): Promise<number> {
  const missing = TOOL_KEYS.filter((toolKey) => !authStorage.has(toolKey.provider) && !process.env[toolKey.envVar])
  if (missing.length === 0) return 0

  const wantToolKeys = await p.confirm({
    message: 'Set up optional tool API keys? (web search, docs, etc.)',
    initialValue: false,
  })

  if (p.isCancel(wantToolKeys) || !wantToolKeys) return 0

  let savedCount = 0
  for (const toolKey of missing) {
    const key = await p.password({
      message: `${toolKey.label} ${pc.dim(`(${toolKey.hint})`)} - Enter to skip:`,
      mask: '●',
    })

    if (p.isCancel(key)) break

    const trimmed = typeof key === 'string' ? key.trim() : ''
    if (trimmed) {
      authStorage.set(toolKey.provider, { type: 'api_key', key: trimmed })
      process.env[toolKey.envVar] = trimmed
      p.log.success(`${toolKey.label} saved`)
      savedCount++
    } else {
      authStorage.set(toolKey.provider, { type: 'api_key', key: '' })
      p.log.info(pc.dim(`${toolKey.label} skipped`))
    }
  }

  return savedCount
}
