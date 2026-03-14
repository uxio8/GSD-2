import { exec } from 'node:child_process'
import type { AuthStorage } from '@mariozechner/pi-coding-agent'
import { renderLogo } from './logo.js'

interface ToolKeyConfig {
  provider: string
  envVar: string
  label: string
  hint: string
}

interface OnboardingOptions {
  configMode?: boolean
  managedLlmProviderLabel?: string | null
}

interface LlmSelectionResult {
  configured: boolean
  providerId: string | null
  label: string | null
}

type SearchChoice = 'anthropic-native' | 'brave' | 'tavily' | 'skip'

type ClackModule = typeof import('@clack/prompts')
type PicoModule = {
  cyan: (s: string) => string
  green: (s: string) => string
  yellow: (s: string) => string
  dim: (s: string) => string
  bold: (s: string) => string
}

const OPTIONAL_TOOL_KEYS: ToolKeyConfig[] = [
  { provider: 'context7', envVar: 'CONTEXT7_API_KEY', label: 'Context7', hint: 'up-to-date library docs' },
  { provider: 'gemini', envVar: 'GEMINI_API_KEY', label: 'Google Gemini', hint: 'Google search + image generation' },
  { provider: 'jina', envVar: 'JINA_API_KEY', label: 'Jina AI', hint: 'clean web page extraction' },
  { provider: 'slack_bot', envVar: 'SLACK_BOT_TOKEN', label: 'Slack Bot', hint: 'remote questions in auto-mode' },
  { provider: 'discord_bot', envVar: 'DISCORD_BOT_TOKEN', label: 'Discord Bot', hint: 'remote questions in auto-mode' },
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

const SEARCH_PREFERENCE_KEY = 'search_provider'

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

function setStoredApiKey(authStorage: AuthStorage, provider: string, key: string): void {
  authStorage.remove(provider)
  authStorage.set(provider, { type: 'api_key', key })
}

function removeStoredApiKey(authStorage: AuthStorage, provider: string, envVar?: string): void {
  authStorage.remove(provider)
  if (envVar) delete process.env[envVar]
}

export function getConfiguredLlmProviderId(authStorage: AuthStorage): string | null {
  for (const providerId of LLM_PROVIDER_IDS) {
    if (authStorage.hasAuth(providerId)) return providerId
  }
  return null
}

function getProviderLabel(providerId: string): string {
  switch (providerId) {
    case 'anthropic':
      return 'Anthropic'
    case 'openai':
      return 'OpenAI'
    case 'github-copilot':
      return 'GitHub Copilot'
    case 'openai-codex':
      return 'ChatGPT Codex'
    case 'google-gemini-cli':
      return 'Gemini CLI'
    case 'google-antigravity':
      return 'Antigravity'
    case 'google':
      return 'Google'
    case 'groq':
      return 'Groq'
    case 'xai':
      return 'xAI'
    case 'openrouter':
      return 'OpenRouter'
    case 'mistral':
      return 'Mistral'
    default:
      return providerId
  }
}

function getSearchPreference(authStorage: AuthStorage): 'auto' | 'brave' | 'tavily' {
  const stored = authStorage.get(SEARCH_PREFERENCE_KEY)
  if (stored?.type === 'api_key' && (stored.key === 'auto' || stored.key === 'brave' || stored.key === 'tavily')) {
    return stored.key
  }
  return 'auto'
}

function setSearchPreference(authStorage: AuthStorage, pref: 'auto' | 'brave' | 'tavily'): void {
  authStorage.remove(SEARCH_PREFERENCE_KEY)
  authStorage.set(SEARCH_PREFERENCE_KEY, { type: 'api_key', key: pref })
}

function clearSearchPreference(authStorage: AuthStorage): void {
  authStorage.remove(SEARCH_PREFERENCE_KEY)
}

export function getConfiguredSearchLabel(authStorage: AuthStorage, llmProviderId: string | null): string | null {
  const pref = getSearchPreference(authStorage)
  const hasBrave = !!(process.env.BRAVE_API_KEY || authStorage.get('brave')?.type === 'api_key' && authStorage.get('brave')?.key)
  const hasTavily = !!(process.env.TAVILY_API_KEY || authStorage.get('tavily')?.type === 'api_key' && authStorage.get('tavily')?.key)

  if (pref === 'brave' && hasBrave) return 'Brave'
  if (pref === 'tavily' && hasTavily) return 'Tavily'
  if (pref === 'auto') {
    if (llmProviderId === 'anthropic') return 'Anthropic built-in'
    if (hasTavily) return 'Tavily'
    if (hasBrave) return 'Brave'
  }

  if (hasTavily) return 'Tavily'
  if (hasBrave) return 'Brave'
  return null
}

export function shouldRunOnboarding(authStorage: AuthStorage): boolean {
  if (!process.stdin.isTTY) return false
  return !LLM_PROVIDER_IDS.some((provider) => authStorage.hasAuth(provider))
}

export async function runOnboarding(
  authStorage: AuthStorage,
  options: OnboardingOptions = {},
): Promise<void> {
  let p: ClackModule
  let pc: PicoModule

  try {
    ;[p, pc] = await Promise.all([loadClack(), loadPico()])
  } catch (error) {
    process.stderr.write(`[gsd] Onboarding wizard unavailable: ${error instanceof Error ? error.message : String(error)}\n`)
    return
  }

  process.stderr.write(renderLogo(pc.cyan))
  p.intro(pc.bold(options.configMode ? 'Update your GSD setup' : "Welcome to GSD - let's get you set up"))

  let llmResult: LlmSelectionResult = {
    configured: false,
    providerId: getConfiguredLlmProviderId(authStorage),
    label: options.managedLlmProviderLabel ?? null,
  }

  try {
    llmResult = await runLlmStep(p, pc, authStorage, options)
  } catch (error) {
    if (p.isCancel(error)) {
      p.cancel(options.configMode ? 'Setup cancelled.' : 'Setup cancelled - you can run `gsd config` later.')
      return
    }
    p.log.warn(`LLM setup failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  let searchResultLabel = getConfiguredSearchLabel(authStorage, llmResult.providerId)
  try {
    searchResultLabel = await runSearchStep(p, pc, authStorage, llmResult.providerId)
  } catch (error) {
    if (p.isCancel(error)) {
      p.cancel('Setup cancelled.')
      return
    }
    p.log.warn(`Web search setup failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  let toolKeyCount = 0
  try {
    toolKeyCount = await runToolKeysStep(p, pc, authStorage)
  } catch (error) {
    if (p.isCancel(error)) {
      p.cancel('Setup cancelled.')
      return
    }
    p.log.warn(`Optional tool setup failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  const summaryLines: string[] = []
  if (llmResult.providerId) {
    summaryLines.push(`${pc.green('✓')} LLM provider: ${llmResult.label ?? getProviderLabel(llmResult.providerId)}`)
  } else {
    summaryLines.push(`${pc.yellow('↷')} LLM provider: skipped`)
  }

  summaryLines.push(
    searchResultLabel
      ? `${pc.green('✓')} Web search: ${searchResultLabel}`
      : `${pc.dim('↷')} Web search: skipped`,
  )

  if (toolKeyCount > 0) {
    summaryLines.push(`${pc.green('✓')} ${toolKeyCount} optional key${toolKeyCount > 1 ? 's' : ''} saved`)
  } else {
    summaryLines.push(`${pc.dim('↷')} Optional tool keys: unchanged`)
  }

  p.note(summaryLines.join('\n'), 'Setup complete')
  p.outro(pc.dim(options.configMode ? 'Configuration updated.' : 'Launching GSD...'))
}

async function runLlmStep(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
  options: OnboardingOptions,
): Promise<LlmSelectionResult> {
  const oauthProviders = authStorage.getOAuthProviders()
  const oauthMap = new Map(oauthProviders.map((provider) => [provider.id, provider]))
  const managedLabel = options.managedLlmProviderLabel ?? null
  const currentProviderId = managedLabel ? 'openai-codex' : getConfiguredLlmProviderId(authStorage)
  const currentLabel = managedLabel ?? (currentProviderId ? getProviderLabel(currentProviderId) : null)

  const methodOptions: Array<{ value: string; label: string; hint?: string }> = []
  if (currentLabel) {
    methodOptions.push({ value: 'keep-current', label: `Keep current (${currentLabel})`, hint: 'leave your current LLM as-is' })
  }
  methodOptions.push(
    { value: 'browser', label: 'Browser login', hint: 'recommended' },
    { value: 'api-key', label: 'API key', hint: 'paste a provider key' },
    { value: 'skip', label: 'Skip for now' },
  )

  const method = await p.select({
    message: 'How do you want to connect your main LLM?',
    options: methodOptions,
  })

  if (p.isCancel(method) || method === 'skip') {
    return {
      configured: false,
      providerId: currentProviderId,
      label: currentLabel,
    }
  }

  if (method === 'keep-current') {
    return {
      configured: true,
      providerId: currentProviderId,
      label: currentLabel,
    }
  }

  if (method === 'browser') {
    const optionsList = [
      { value: 'anthropic', label: 'Anthropic', hint: 'Claude in your browser' },
      { value: 'github-copilot', label: 'GitHub Copilot' },
      ...(managedLabel ? [] : [{ value: 'openai-codex', label: 'ChatGPT Codex' }]),
      { value: 'google-gemini-cli', label: 'Gemini CLI' },
      { value: 'google-antigravity', label: 'Antigravity' },
    ]

    const providerId = await p.select({
      message: 'Which provider do you want to sign into?',
      options: optionsList,
    })

    if (p.isCancel(providerId)) {
      return {
        configured: false,
        providerId: currentProviderId,
        label: currentLabel,
      }
    }

    const ok = await runOAuthFlow(p, pc, authStorage, String(providerId), oauthMap)
    return {
      configured: ok,
      providerId: ok ? String(providerId) : currentProviderId,
      label: ok ? getProviderLabel(String(providerId)) : currentLabel,
    }
  }

  const providerChoice = await p.select({
    message: 'Which provider key do you want to save?',
    options: [
      { value: 'anthropic', label: 'Anthropic' },
      { value: 'openai', label: 'OpenAI' },
      { value: 'other', label: 'Other provider' },
    ],
  })

  if (p.isCancel(providerChoice)) {
    return {
      configured: false,
      providerId: currentProviderId,
      label: currentLabel,
    }
  }

  if (providerChoice === 'other') {
    const other = await runOtherProviderFlow(p, pc, authStorage)
    return {
      configured: other.configured,
      providerId: other.providerId ?? currentProviderId,
      label: other.label ?? currentLabel,
    }
  }

  const providerId = String(providerChoice)
  const ok = await runApiKeyFlow(p, pc, authStorage, providerId, getProviderLabel(providerId))
  return {
    configured: ok,
    providerId: ok ? providerId : currentProviderId,
    label: ok ? getProviderLabel(providerId) : currentLabel,
  }
}

async function runOAuthFlow(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
  providerId: string,
  oauthMap: Map<string, { id: string; name?: string; usesCallbackServer?: boolean }>,
): Promise<boolean> {
  const providerInfo = oauthMap.get(providerId)
  const providerName = providerInfo?.name ?? getProviderLabel(providerId)
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
        const result = await p.text({ message: prompt.message, placeholder: prompt.placeholder })
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

    p.log.success(`Connected ${pc.green(providerName)}`)
    return true
  } catch (error) {
    spinner.stop(`${providerName} authentication failed`)
    p.log.warn(`Login failed: ${error instanceof Error ? error.message : String(error)}`)
    const retry = await p.select({
      message: 'What do you want to do?',
      options: [
        { value: 'retry', label: 'Try again' },
        { value: 'skip', label: 'Skip for now' },
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
    p.log.warn(`Key doesn't start with ${expectedPrefixes.join(' or ')}. Saving anyway.`)
  }

  setStoredApiKey(authStorage, providerId, trimmed)
  p.log.success(`Saved ${pc.green(providerLabel)} key`)
  return true
}

async function runOtherProviderFlow(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
): Promise<{ configured: boolean; providerId: string | null; label: string | null }> {
  const provider = await p.select({
    message: 'Select provider',
    options: OTHER_PROVIDERS.map((option) => ({ value: option.value, label: option.label })),
  })

  if (p.isCancel(provider)) {
    return { configured: false, providerId: null, label: null }
  }

  const providerId = String(provider)
  const label = OTHER_PROVIDERS.find((option) => option.value === providerId)?.label ?? providerId
  const configured = await runApiKeyFlow(p, pc, authStorage, providerId, label)
  return { configured, providerId: configured ? providerId : null, label: configured ? label : null }
}

async function runSearchStep(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
  llmProviderId: string | null,
): Promise<string | null> {
  const current = getConfiguredSearchLabel(authStorage, llmProviderId)
  const options: Array<{ value: SearchChoice | 'keep-current'; label: string; hint?: string }> = []
  if (current) {
    options.push({ value: 'keep-current', label: `Keep current (${current})`, hint: 'leave web search as-is' })
  }
  if (llmProviderId === 'anthropic') {
    options.push({ value: 'anthropic-native', label: 'Anthropic built-in', hint: 'use native search for Anthropic sessions' })
  }
  options.push(
    { value: 'brave', label: 'Brave Search' },
    { value: 'tavily', label: 'Tavily Search' },
    { value: 'skip', label: 'Skip web search' },
  )

  const choice = await p.select({
    message: 'Which web search setup do you want?',
    options,
  })

  if (p.isCancel(choice) || choice === 'keep-current') {
    return current
  }

  if (choice === 'anthropic-native') {
    setSearchPreference(authStorage, 'auto')
    return 'Anthropic built-in'
  }

  if (choice === 'skip') {
    clearSearchPreference(authStorage)
    removeStoredApiKey(authStorage, 'brave', 'BRAVE_API_KEY')
    removeStoredApiKey(authStorage, 'tavily', 'TAVILY_API_KEY')
    return null
  }

  const provider = choice === 'brave' ? 'brave' : 'tavily'
  const envVar = provider === 'brave' ? 'BRAVE_API_KEY' : 'TAVILY_API_KEY'
  const label = provider === 'brave' ? 'Brave Search' : 'Tavily Search'
  const key = await p.password({
    message: `Paste your ${label} API key:`,
    mask: '●',
  })

  if (p.isCancel(key) || !String(key).trim()) {
    p.log.info(pc.dim(`${label} skipped`))
    return current
  }

  const trimmed = String(key).trim()
  setStoredApiKey(authStorage, provider, trimmed)
  process.env[envVar] = trimmed
  setSearchPreference(authStorage, provider)
  p.log.success(`${label} saved`)
  return label
}

async function runToolKeysStep(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
): Promise<number> {
  const missing = OPTIONAL_TOOL_KEYS.filter((toolKey) => !authStorage.has(toolKey.provider) && !process.env[toolKey.envVar])
  if (missing.length === 0) return 0

  const wantToolKeys = await p.confirm({
    message: 'Set up optional extra tools now?',
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
      setStoredApiKey(authStorage, toolKey.provider, trimmed)
      process.env[toolKey.envVar] = trimmed
      p.log.success(`${toolKey.label} saved`)
      savedCount++
    } else {
      removeStoredApiKey(authStorage, toolKey.provider, toolKey.envVar)
      p.log.info(pc.dim(`${toolKey.label} skipped`))
    }
  }

  return savedCount
}
