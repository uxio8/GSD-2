import {
  AuthStorage,
  InteractiveMode,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  runPrintMode,
  runRpcMode,
} from '@mariozechner/pi-coding-agent'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir, authFilePath } from './app-paths.js'
import { createProjectSessionManager, formatCliHelp, getInteractiveCliError, parseCliArgs } from './cli-support.js'
import { prepareCloudPoolSession } from './cloud-pool.js'
import { getPiDefaultModelAndProvider, migratePiCredentials } from './pi-migration.js'
import { loadProjectOptionalEnvKeys } from './project-env.js'
import { buildResourceLoader, initResources } from './resource-loader.js'
import { ensureManagedTools } from './tool-bootstrap.js'
import { loadStoredEnvKeys, runWizardIfNeeded } from './wizard.js'
import { runOnboarding, shouldRunOnboarding } from './onboarding.js'

function loadAppendSystemPrompt(pathOrText: string | undefined): string | undefined {
  if (!pathOrText) return undefined
  try {
    return readFileSync(pathOrText, 'utf-8')
  } catch {
    return pathOrText
  }
}

const cliFlags = parseCliArgs(process.argv)

if (cliFlags.version) {
  process.stdout.write(`${process.env.GSD_VERSION || '0.0.0'}\n`)
  process.exit(0)
}

if (cliFlags.help) {
  process.stdout.write(formatCliHelp(process.env.GSD_VERSION || '0.0.0'))
  process.exit(0)
}

const isPrintMode = cliFlags.print || cliFlags.mode !== undefined
const interactiveCliError = getInteractiveCliError(isPrintMode, !!process.stdin.isTTY)

if (interactiveCliError) {
  process.stderr.write(`${interactiveCliError}\n`)
  process.exit(1)
}

if (!isPrintMode && cliFlags.messages[0] === 'config') {
  await runOnboarding(AuthStorage.create(authFilePath))
  process.exit(0)
}

// Pi's tool bootstrap can mis-detect already-installed fd/rg on some systems
// because spawnSync(..., ["--version"]) returns EPERM despite a zero exit code.
// Provision local managed binaries first so Pi sees them without probing PATH.
ensureManagedTools(join(agentDir, 'bin'))

const cwd = process.cwd()
loadProjectOptionalEnvKeys(cwd)
const cloudPoolSession = await prepareCloudPoolSession(cwd, authFilePath)
const authStorage = cloudPoolSession.authStorage
migratePiCredentials(authStorage)
loadStoredEnvKeys(authStorage)

// Print/subagent mode has no TTY, so the setup wizard must stay disabled there.
if (!isPrintMode) {
  if (shouldRunOnboarding(authStorage)) {
    await runOnboarding(authStorage)
  } else {
    await runWizardIfNeeded(authStorage)
  }
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
const configuredExists = configuredProvider && configuredModel &&
  allModels.some((m) => m.provider === configuredProvider && m.id === configuredModel)
const configuredAvailable = configuredProvider && configuredModel &&
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
const effectiveExists = effectiveProvider && effectiveModel &&
  allModels.some((m) => m.provider === effectiveProvider && m.id === effectiveModel)
const effectiveAvailable = effectiveProvider && effectiveModel &&
  availableModels.some((m) => m.provider === effectiveProvider && m.id === effectiveModel)

if (!effectiveModel || !effectiveExists || !effectiveAvailable) {
  const piDefault = cloudPoolSession.poolActive ? null : getPiDefaultModelAndProvider()
  const preferred =
    (piDefault
      ? availableModels.find((m) => m.provider === piDefault.provider && m.id === piDefault.model)
      : undefined) ||
    availableModels.find((m) => m.provider === 'openai' && m.id === 'gpt-5.4') ||
    availableModels.find((m) => m.provider === 'openai') ||
    availableModels.find((m) => m.provider === 'anthropic' && m.id === 'claude-opus-4-6') ||
    availableModels.find((m) => m.provider === 'anthropic' && m.id.includes('opus')) ||
    availableModels.find((m) => m.provider === 'anthropic') ||
    availableModels[0]
  if (preferred) {
    settingsManager.setDefaultModelAndProvider(preferred.provider, preferred.id)
  }
}

if (settingsManager.getDefaultThinkingLevel() !== 'off' && (!effectiveExists || !effectiveAvailable)) {
  settingsManager.setDefaultThinkingLevel('off')
}

if (!settingsManager.getQuietStartup()) {
  settingsManager.setQuietStartup(true)
}

if (!settingsManager.getCollapseChangelog()) {
  settingsManager.setCollapseChangelog(true)
}

initResources(agentDir)

async function runCli(): Promise<void> {
  if (isPrintMode) {
    const sessionManager = cliFlags.noSession
      ? SessionManager.inMemory()
      : createProjectSessionManager(cwd)
    const resourceLoader = buildResourceLoader(agentDir, {
      additionalExtensionPaths: cliFlags.extensions,
      appendSystemPrompt: loadAppendSystemPrompt(cliFlags.appendSystemPrompt),
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
    if (mode === 'rpc') {
      await runRpcMode(session)
      return
    }

    await runPrintMode(session, { mode, messages: cliFlags.messages })
    return
  }

  const sessionManager = createProjectSessionManager(cwd, { continueRecent: cliFlags.continue })
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
        const model = availableModels.find((m) => m.provider === provider && m.id === modelId)
        if (model) {
          const key = `${model.provider}/${model.id}`
          if (!seen.has(key)) {
            seen.add(key)
            scopedModels.push({ model })
          }
        }
      } else {
        const model = availableModels.find((m) => m.id === pattern)
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

try {
  await runCli()
} finally {
  await cloudPoolSession.cleanup()
}
