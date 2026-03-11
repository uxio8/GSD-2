import {
  DefaultResourceLoader,
  ModelRegistry,
  SettingsManager,
  SessionManager,
  createAgentSession,
  InteractiveMode,
  runPrintMode,
} from '@mariozechner/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir, sessionsDir, authFilePath } from './app-paths.js'
import { prepareCloudPoolSession } from './cloud-pool.js'
import { buildResourceLoader, initResources } from './resource-loader.js'
import { ensureManagedTools } from './tool-bootstrap.js'
import { loadStoredEnvKeys, runWizardIfNeeded } from './wizard.js'

// ---------------------------------------------------------------------------
// Minimal CLI arg parser — detects print/subagent mode flags
// ---------------------------------------------------------------------------
interface CliFlags {
  mode?: 'text' | 'json' | 'rpc'
  print?: boolean
  noSession?: boolean
  model?: string
  extensions: string[]
  appendSystemPrompt?: string
  tools?: string[]
  messages: string[]
}

function parseCliArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { extensions: [], messages: [] }
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--mode' && i + 1 < args.length) {
      const mode = args[++i]
      if (mode === 'text' || mode === 'json' || mode === 'rpc') flags.mode = mode
    } else if (arg === '--print' || arg === '-p') {
      flags.print = true
    } else if (arg === '--no-session') {
      flags.noSession = true
    } else if (arg === '--model' && i + 1 < args.length) {
      flags.model = args[++i]
    } else if (arg === '--extension' && i + 1 < args.length) {
      flags.extensions.push(args[++i])
    } else if (arg === '--append-system-prompt' && i + 1 < args.length) {
      flags.appendSystemPrompt = args[++i]
    } else if (arg === '--tools' && i + 1 < args.length) {
      flags.tools = args[++i].split(',')
    } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
      flags.messages.push(arg)
    }
  }
  return flags
}

const cwd = process.cwd()
const cliFlags = parseCliArgs(process.argv)
const isPrintMode = cliFlags.print || cliFlags.mode !== undefined

// Pi's tool bootstrap can mis-detect already-installed fd/rg on some systems
// because spawnSync(..., ["--version"]) returns EPERM despite a zero exit code.
// Provision local managed binaries first so Pi sees them without probing PATH.
ensureManagedTools(join(agentDir, 'bin'))

const cloudPoolSession = await prepareCloudPoolSession(cwd, authFilePath)
const authStorage = cloudPoolSession.authStorage
loadStoredEnvKeys(authStorage)

// Skip the setup wizard in print mode — it requires TTY interaction
if (!isPrintMode) {
  await runWizardIfNeeded(authStorage)
}

const modelRegistry = new ModelRegistry(authStorage)
const settingsManager = SettingsManager.create(agentDir)

// Validate configured model on startup — catches stale settings from prior installs
// (e.g. grok-2 which no longer exists) and fresh installs with no settings.
// Only resets the default when the configured model no longer exists in the registry;
// never overwrites a valid user choice.
const configuredProvider = settingsManager.getDefaultProvider()
const configuredModel = settingsManager.getDefaultModel()
const allModels = modelRegistry.getAll()
const availableModels = modelRegistry.getAvailable()
const configuredExists =
  configuredProvider &&
  configuredModel &&
  allModels.some((m) => m.provider === configuredProvider && m.id === configuredModel)
const configuredAvailable =
  configuredProvider &&
  configuredModel &&
  availableModels.some((m) => m.provider === configuredProvider && m.id === configuredModel)

if (cloudPoolSession.poolActive && !configuredAvailable) {
  const pooledDefault =
    availableModels.find((m) => m.provider === 'openai-codex' && m.id === 'gpt-5.4') ||
    availableModels.find((m) => m.provider === 'openai-codex')
  if (pooledDefault) {
    settingsManager.setDefaultModelAndProvider(pooledDefault.provider, pooledDefault.id)
  }
}

const effectiveProvider = settingsManager.getDefaultProvider()
const effectiveModel = settingsManager.getDefaultModel()
const effectiveExists =
  effectiveProvider &&
  effectiveModel &&
  allModels.some((m) => m.provider === effectiveProvider && m.id === effectiveModel)

if (!effectiveModel || !effectiveExists) {
  // Fallback: pick the best available Anthropic model
  const preferred =
    allModels.find((m) => m.provider === 'anthropic' && m.id === 'claude-opus-4-6') ||
    allModels.find((m) => m.provider === 'anthropic' && m.id.includes('opus')) ||
    allModels.find((m) => m.provider === 'anthropic')
  if (preferred) {
    settingsManager.setDefaultModelAndProvider(preferred.provider, preferred.id)
  }
}

// Default thinking level: off (always reset if not explicitly set)
if (settingsManager.getDefaultThinkingLevel() !== 'off' && !effectiveExists) {
  settingsManager.setDefaultThinkingLevel('off')
}

// GSD always uses quiet startup — the gsd extension renders its own branded header
if (!settingsManager.getQuietStartup()) {
  settingsManager.setQuietStartup(true)
}

// Collapse changelog by default — avoid wall of text on updates
if (!settingsManager.getCollapseChangelog()) {
  settingsManager.setCollapseChangelog(true)
}

try {
  if (isPrintMode) {
    const sessionManager = cliFlags.noSession
      ? SessionManager.inMemory()
      : SessionManager.create(cwd)

    let appendSystemPrompt: string | undefined
    if (cliFlags.appendSystemPrompt) {
      try {
        appendSystemPrompt = readFileSync(cliFlags.appendSystemPrompt, 'utf-8')
      } catch {
        appendSystemPrompt = cliFlags.appendSystemPrompt
      }
    }

    initResources(agentDir)
    const resourceLoader = new DefaultResourceLoader({
      agentDir,
      additionalExtensionPaths: cliFlags.extensions.length > 0 ? cliFlags.extensions : undefined,
      appendSystemPrompt,
    })
    await resourceLoader.reload()

    const { session, extensionsResult } = await createAgentSession({
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager,
      resourceLoader,
    })

    if (extensionsResult.errors.length > 0) {
      for (const err of extensionsResult.errors) {
        process.stderr.write(`[gsd] Extension load error: ${err.error}\n`)
      }
    }

    if (cliFlags.model) {
      const match =
        availableModels.find((m) => m.id === cliFlags.model) ||
        availableModels.find((m) => `${m.provider}/${m.id}` === cliFlags.model)
      if (match) {
        session.setModel(match)
      }
    }

    const mode = cliFlags.mode || 'text'
    await runPrintMode(session, {
      mode: mode === 'rpc' ? 'json' : mode,
      messages: cliFlags.messages,
    })
  } else {
    // Per-directory session storage — same encoding as the upstream SDK so that
    // /resume only shows sessions from the current working directory.
    const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
    const projectSessionsDir = join(sessionsDir, safePath)
    const sessionManager = SessionManager.create(cwd, projectSessionsDir)

    initResources(agentDir)
    const resourceLoader = buildResourceLoader(agentDir)
    await resourceLoader.reload()

    const { session, extensionsResult } = await createAgentSession({
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager,
      resourceLoader,
    })

    if (extensionsResult.errors.length > 0) {
      for (const err of extensionsResult.errors) {
        process.stderr.write(`[gsd] Extension load error: ${err.error}\n`)
      }
    }

    // Restore scoped models from settings on startup.
    // The upstream InteractiveMode reads enabledModels from settings when /scoped-models is opened,
    // but doesn't apply them to the session at startup — so Ctrl+P cycles all models instead of
    // just the saved selection until the user re-runs /scoped-models.
    const enabledModelPatterns = settingsManager.getEnabledModels()
    if (enabledModelPatterns && enabledModelPatterns.length > 0) {
      const scopedModels: Array<{ model: (typeof availableModels)[number] }> = []
      const seen = new Set<string>()

      for (const pattern of enabledModelPatterns) {
        const slashIdx = pattern.indexOf('/')
        if (slashIdx !== -1) {
          const provider = pattern.substring(0, slashIdx)
          const modelId = pattern.substring(slashIdx + 1)
          const model = availableModels.find(
            (candidate) => candidate.provider === provider && candidate.id === modelId,
          )
          if (model) {
            const key = `${model.provider}/${model.id}`
            if (!seen.has(key)) {
              seen.add(key)
              scopedModels.push({ model })
            }
          }
        } else {
          const model = availableModels.find((candidate) => candidate.id === pattern)
          if (model) {
            const key = `${model.provider}/${model.id}`
            if (!seen.has(key)) {
              seen.add(key)
              scopedModels.push({ model })
            }
          }
        }
      }

      if (scopedModels.length > 0 && scopedModels.length < availableModels.length) {
        session.setScopedModels(scopedModels)
      }
    }

    const interactiveMode = new InteractiveMode(session)
    await interactiveMode.run()
  }
} finally {
  await cloudPoolSession.cleanup()
}
