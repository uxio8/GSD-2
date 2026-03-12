import {
  ModelRegistry,
  SettingsManager,
  SessionManager,
  createAgentSession,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/index.js";
import { appendFileSync, mkdirSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, sessionsDir, authFilePath } from "../dist/app-paths.js";
import { prepareCloudPoolSession } from "../dist/cloud-pool.js";
import { buildResourceLoader, initResources } from "../dist/resource-loader.js";
import { ensureManagedTools } from "../dist/tool-bootstrap.js";
import { loadStoredEnvKeys } from "../dist/wizard.js";
import { parseStateSnapshot, isTerminalState } from "./headless-auto-state.mjs";

const gsdRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const logFile = process.argv[3] ? resolve(process.argv[3]) : join(cwd, ".gsd", "auto-run.log");
const autoLock = join(cwd, ".gsd", "auto.lock");
const stateFile = join(cwd, ".gsd", "STATE.md");
const idleChecksBeforeRelaunch = 3;
const maxConsecutiveRelaunches = 3;
const maxContextLimitRelaunchesPerUnit = 2;
const staleStreamingMs = 2 * 60 * 1000;
const maxStaleStreamingResetsPerUnit = 2;

function log(message) {
  mkdirSync(dirname(logFile), { recursive: true });
  appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`, "utf8");
}

function readStateSnapshot() {
  if (!existsSync(stateFile)) return null;

  try {
    const raw = readFileSync(stateFile, "utf8");
    return parseStateSnapshot(raw);
  } catch (error) {
    log(`state-read-error ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function readLockSnapshot() {
  if (!existsSync(autoLock)) return null;

  try {
    return JSON.parse(readFileSync(autoLock, "utf8"));
  } catch (error) {
    log(`lock-read-error ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function isContextLengthError(message) {
  return /context_length_exceeded|context window/i.test(message);
}

async function promptAuto(session, reason) {
  markActivity();
  log(`auto-command start reason=${reason}`);
  try {
    await session.prompt("/gsd auto");
    markActivity();
    log(`auto-command complete reason=${reason}`);
    return true;
  } catch (error) {
    log(`auto-command failed reason=${reason}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return false;
  }
}

async function ensureRuntimeEnv() {
  const pkgDir = resolve(gsdRoot, "pkg");
  process.env.PI_PACKAGE_DIR = pkgDir;
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.GSD_CODING_AGENT_DIR = agentDir;

  const gsdNodeModules = join(gsdRoot, "node_modules");
  process.env.NODE_PATH = process.env.NODE_PATH
    ? `${gsdNodeModules}:${process.env.NODE_PATH}`
    : gsdNodeModules;

  const { Module } = await import("module");
  Module._initPaths?.();
}

function setVersionEnv() {
  try {
    const pkgJson = JSON.parse(readFileSync(join(gsdRoot, "package.json"), "utf8"));
    process.env.GSD_VERSION = pkgJson.version || "0.0.0";
  } catch {
    process.env.GSD_VERSION = "0.0.0";
  }
}

function setWorkflowEnv() {
  process.env.GSD_BIN_PATH = join(gsdRoot, "dist", "loader.js");
  process.env.GSD_WORKFLOW_PATH = join(gsdRoot, "src", "resources", "GSD-WORKFLOW.md");
  process.env.GSD_BUNDLED_EXTENSION_PATHS = [
    join(agentDir, "extensions", "gsd", "index.ts"),
    join(agentDir, "extensions", "bg-shell", "index.ts"),
    join(agentDir, "extensions", "browser-tools", "index.ts"),
    join(agentDir, "extensions", "context7", "index.ts"),
    join(agentDir, "extensions", "search-the-web", "index.ts"),
    join(agentDir, "extensions", "slash-commands", "index.ts"),
    join(agentDir, "extensions", "subagent", "index.ts"),
    join(agentDir, "extensions", "mac-tools", "index.ts"),
    join(agentDir, "extensions", "ask-user-questions.ts"),
    join(agentDir, "extensions", "get-secrets-from-user.ts"),
  ].join(":");
}

function applyDefaultModelSettings(settingsManager, modelRegistry, poolActive) {
  const configuredProvider = settingsManager.getDefaultProvider();
  const configuredModel = settingsManager.getDefaultModel();
  const allModels = modelRegistry.getAll();
  const availableModels = modelRegistry.getAvailable();
  const configuredExists = configuredProvider && configuredModel &&
    allModels.some((m) => m.provider === configuredProvider && m.id === configuredModel);
  const configuredAvailable = configuredProvider && configuredModel &&
    availableModels.some((m) => m.provider === configuredProvider && m.id === configuredModel);

  if (poolActive && !configuredAvailable) {
    const pooledDefault =
      availableModels.find((m) => m.provider === "openai-codex" && m.id === "gpt-5.4") ||
      availableModels.find((m) => m.provider === "openai-codex");
    if (pooledDefault) {
      settingsManager.setDefaultModelAndProvider(pooledDefault.provider, pooledDefault.id);
    }
  }

  const effectiveProvider = settingsManager.getDefaultProvider();
  const effectiveModel = settingsManager.getDefaultModel();
  const effectiveExists = effectiveProvider && effectiveModel &&
    allModels.some((m) => m.provider === effectiveProvider && m.id === effectiveModel);

  if (!effectiveModel || !effectiveExists) {
    const preferred =
      allModels.find((m) => m.provider === "anthropic" && m.id === "claude-opus-4-6") ||
      allModels.find((m) => m.provider === "anthropic" && m.id.includes("opus")) ||
      allModels.find((m) => m.provider === "anthropic");
    if (preferred) {
      settingsManager.setDefaultModelAndProvider(preferred.provider, preferred.id);
    }
  }

  if (settingsManager.getQuietStartup() !== true) settingsManager.setQuietStartup(true);
  if (settingsManager.getCollapseChangelog() !== true) settingsManager.setCollapseChangelog(true);
  if (settingsManager.getDefaultThinkingLevel() !== "off" && !effectiveExists) {
    settingsManager.setDefaultThinkingLevel("off");
  }
}

function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("");
}

function maybeRotateOnUsageLimit(errorMessage) {
  if (!cloudPoolSession.poolActive) return;
  if (!errorMessage) return;
  if (usageLimitRotation) return;

  usageLimitRotation = (async () => {
    try {
      const rotated = await cloudPoolSession.rotateOnUsageLimit(errorMessage);
      if (!rotated) return;
      pendingRelaunchReason = "usage-limit-rotate";
      log("usage-limit-rotated");
    } catch (error) {
      log(`usage-limit-rotation-failed ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      usageLimitRotation = null;
    }
  })();
}

await ensureRuntimeEnv();
setVersionEnv();
setWorkflowEnv();
process.chdir(cwd);
ensureManagedTools(join(agentDir, "bin"));

const cloudPoolSession = await prepareCloudPoolSession(cwd, authFilePath);
const authStorage = cloudPoolSession.authStorage;
loadStoredEnvKeys(authStorage);

const modelRegistry = new ModelRegistry(authStorage);
const settingsManager = SettingsManager.create(agentDir);
applyDefaultModelSettings(settingsManager, modelRegistry, cloudPoolSession.poolActive);

const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const projectSessionsDir = join(sessionsDir, safePath);
const sessionManager = SessionManager.create(cwd, projectSessionsDir);
initResources(agentDir);
const resourceLoader = buildResourceLoader(agentDir);
await resourceLoader.reload();

let pendingRelaunchReason = null;
let usageLimitRotation = null;
const enabledModelPatterns = settingsManager.getEnabledModels();
let contextLimitUnitId = null;
let contextLimitRelaunches = 0;
let pendingSessionResetReason = null;
let session = null;
let lastActivityAt = Date.now();
let staleStreamUnitId = null;
let staleStreamResets = 0;

function markActivity() {
  lastActivityAt = Date.now();
}

function applyScopedModels(nextSession) {
  if (!enabledModelPatterns || enabledModelPatterns.length === 0) return;

  const availableModels = modelRegistry.getAvailable();
  const scopedModels = [];
  const seen = new Set();

  for (const pattern of enabledModelPatterns) {
    const slashIdx = pattern.indexOf("/");
    if (slashIdx !== -1) {
      const provider = pattern.substring(0, slashIdx);
      const modelId = pattern.substring(slashIdx + 1);
      const model = availableModels.find((m) => m.provider === provider && m.id === modelId);
      if (model) {
        const key = `${model.provider}/${model.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          scopedModels.push({ model });
        }
      }
    } else {
      const model = availableModels.find((m) => m.id === pattern);
      if (model) {
        const key = `${model.provider}/${model.id}`;
        if (!seen.has(key)) {
          seen.add(key);
          scopedModels.push({ model });
        }
      }
    }
  }

  if (scopedModels.length > 0 && scopedModels.length < availableModels.length) {
    nextSession.setScopedModels(scopedModels);
  }
}

function maybeScheduleContextReset(errorMessage) {
  if (!isContextLengthError(errorMessage)) return;

  const lock = readLockSnapshot();
  const unitId = lock?.unitId ?? "unknown";
  if (contextLimitUnitId === unitId) {
    contextLimitRelaunches += 1;
  } else {
    contextLimitUnitId = unitId;
    contextLimitRelaunches = 1;
  }

  pendingSessionResetReason = `context-limit-${contextLimitRelaunches}`;
  pendingRelaunchReason = `context-limit-${contextLimitRelaunches}`;
  log(`context-limit-detected unit=${unitId} count=${contextLimitRelaunches}`);
}

function subscribeSession(nextSession) {
  nextSession.subscribe((event) => {
  try {
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const text = extractText(event.message.content);
      if (text || event.message.errorMessage) markActivity();
      if (text) log(`message-complete ${text.replace(/\s+/g, " ").slice(0, 500)}`);
      if (event.message.stopReason === "error" && event.message.errorMessage) {
        log(`assistant-error ${event.message.errorMessage}`);
        maybeRotateOnUsageLimit(event.message.errorMessage);
        maybeScheduleContextReset(event.message.errorMessage);
      }
      return;
    }

    if (event.type === "message_complete") {
      const text = extractText(event.message?.content);
      if (text) markActivity();
      if (text) log(`message-complete ${text.replace(/\s+/g, " ").slice(0, 500)}`);
      return;
    }

    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta?.replace(/\s+/g, " ");
      if (delta?.trim()) {
        markActivity();
        log(`delta ${delta.slice(0, 200)}`);
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      markActivity();
      log(`tool-start ${event.toolName ?? "unknown"}`);
      return;
    }

    if (event.type === "tool_execution_update") {
      markActivity();
      log(`tool-update ${event.toolName ?? "unknown"}`);
      return;
    }

    if (event.type === "tool_execution_end") {
      markActivity();
      log(`tool-complete ${event.toolName ?? "unknown"}`);
      return;
    }

    if (event.type === "error") {
      markActivity();
      log(`error ${event.error?.message ?? "unknown"}`);
      maybeRotateOnUsageLimit(event.error?.message ?? "");
      maybeScheduleContextReset(event.error?.message ?? "");
    }
  } catch (error) {
    log(`event-log-error ${error instanceof Error ? error.message : String(error)}`);
  }
});
}

async function createManagedSession() {
  const { session: nextSession, extensionsResult } = await createAgentSession({
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager,
    resourceLoader,
  });

  for (const err of extensionsResult.errors) {
    log(`extension-error ${err.path}: ${err.error}`);
  }

  await nextSession.bindExtensions({
    commandContextActions: {
      waitForIdle: () => nextSession.agent.waitForIdle(),
      newSession: async (options) => {
        const success = await nextSession.newSession(options);
        return { cancelled: !success };
      },
      fork: async (entryId) => {
        const result = await nextSession.fork(entryId);
        return { cancelled: result.cancelled };
      },
      navigateTree: async (targetId, options) => {
        const result = await nextSession.navigateTree(targetId, {
          summarize: options?.summarize,
          customInstructions: options?.customInstructions,
          replaceInstructions: options?.replaceInstructions,
          label: options?.label,
        });
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath) => {
        const success = await nextSession.switchSession(sessionPath);
        return { cancelled: !success };
      },
      reload: async () => {
        await nextSession.reload();
      },
    },
    onError: (err) => {
      log(`extension-error ${err.extensionPath}: ${err.error}`);
    },
  });

  applyScopedModels(nextSession);
  subscribeSession(nextSession);
  const startedFresh = await nextSession.newSession();
  if (!startedFresh) {
    throw new Error("failed to open a fresh control session");
  }
  return nextSession;
}

async function resetSession(reason) {
  log(`session-reset start reason=${reason}`);
  try {
    session?.dispose();
  } catch {
  }
  markActivity();
  session = await createManagedSession();
  markActivity();
  log(`session-reset complete reason=${reason} model=${session.model?.provider ?? "unknown"}/${session.model?.id ?? "unknown"}`);
}

session = await createManagedSession();

let cleanedUp = false;
async function cleanupAndExit(code) {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    await cloudPoolSession.cleanup();
  } catch (error) {
    log(`cleanup-error ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    session?.dispose();
  } catch {
  }
  try {
    if (existsSync(autoLock)) unlinkSync(autoLock);
  } catch {
  }
  process.exit(code);
}

process.on("SIGTERM", async () => {
  log("sigterm");
  await cleanupAndExit(0);
});

process.on("SIGINT", async () => {
  log("sigint");
  await cleanupAndExit(0);
});

log(`headless-auto start cwd=${cwd} model=${session.model?.provider ?? "unknown"}/${session.model?.id ?? "unknown"}`);
await promptAuto(session, "initial");

let settledChecks = 0;
let consecutiveRelaunches = 0;
while (true) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
  const lockPresent = existsSync(autoLock);
  const lock = readLockSnapshot();
  const currentUnitId = lock?.unitId ?? null;
  if (currentUnitId && contextLimitUnitId && currentUnitId !== contextLimitUnitId) {
    contextLimitUnitId = null;
    contextLimitRelaunches = 0;
  }
  if (currentUnitId && staleStreamUnitId && currentUnitId !== staleStreamUnitId) {
    staleStreamUnitId = null;
    staleStreamResets = 0;
  }
  const streaming = session.isStreaming;
  const state = readStateSnapshot();
  const phase = state?.phase ?? "unknown";
  const activeTask = state?.activeTask ?? "none";
  log(`heartbeat lock=${lockPresent} streaming=${streaming} phase=${phase} task=${activeTask}`);

  if (lockPresent || streaming) {
    if (lockPresent && streaming && currentUnitId && Date.now() - lastActivityAt >= staleStreamingMs) {
      if (staleStreamUnitId === currentUnitId) {
        staleStreamResets += 1;
      } else {
        staleStreamUnitId = currentUnitId;
        staleStreamResets = 1;
      }

      if (staleStreamResets > maxStaleStreamingResetsPerUnit) {
        log(`headless-auto exit stale-stream-blocked unit=${currentUnitId} phase=${phase} task=${activeTask}`);
        await cleanupAndExit(1);
      }

      log(`stale-stream-detected unit=${currentUnitId} idle_ms=${Date.now() - lastActivityAt} count=${staleStreamResets}`);
      try {
        if (existsSync(autoLock)) unlinkSync(autoLock);
      } catch (error) {
        log(`lock-cleanup-error ${error instanceof Error ? error.message : String(error)}`);
      }
      await resetSession(`stale-stream-${staleStreamResets}`);
      const relaunched = await promptAuto(
        session,
        `stale-stream-${staleStreamResets} phase=${phase} task=${activeTask}`,
      );
      if (!relaunched) break;
    }
    settledChecks = 0;
    consecutiveRelaunches = 0;
    continue;
  }

  if (pendingRelaunchReason) {
    const reason = pendingRelaunchReason;
    pendingRelaunchReason = null;
    settledChecks = 0;
    consecutiveRelaunches = 0;
    const contextResetPending = Boolean(pendingSessionResetReason);
    if (pendingSessionResetReason || reason.startsWith("idle-relaunch") || reason === "usage-limit-rotate") {
      if (contextResetPending && contextLimitRelaunches >= maxContextLimitRelaunchesPerUnit) {
        log(`headless-auto exit context-limit-blocked unit=${contextLimitUnitId ?? "unknown"} phase=${phase} task=${activeTask}`);
        await cleanupAndExit(1);
      }
      await resetSession(pendingSessionResetReason ?? reason);
      pendingSessionResetReason = null;
    }
    const relaunched = await promptAuto(session, reason);
    if (!relaunched) break;
    continue;
  }

  if (isTerminalState(state)) break;

  settledChecks += 1;
  if (settledChecks < idleChecksBeforeRelaunch) continue;

  if (consecutiveRelaunches >= maxConsecutiveRelaunches) {
    log(`headless-auto exit nonterminal-idle phase=${phase} task=${activeTask}`);
    await cleanupAndExit(1);
  }

  consecutiveRelaunches += 1;
  settledChecks = 0;
  await resetSession(`idle-relaunch-${consecutiveRelaunches}`);
  const relaunched = await promptAuto(
    session,
    `idle-relaunch-${consecutiveRelaunches} phase=${phase} task=${activeTask}`,
  );
  if (!relaunched) {
    break;
  }
}

log("headless-auto exit");
await cleanupAndExit(0);
