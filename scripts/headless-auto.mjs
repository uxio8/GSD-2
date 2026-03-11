import {
  ModelRegistry,
  SettingsManager,
  SessionManager,
  createAgentSession,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/index.js";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, sessionsDir, authFilePath } from "../dist/app-paths.js";
import { prepareCloudPoolSession } from "../dist/cloud-pool.js";
import { buildResourceLoader, initResources } from "../dist/resource-loader.js";
import { loadStoredEnvKeys } from "../dist/wizard.js";
import { parseStateSnapshot, isTerminalState } from "./headless-auto-state.mjs";

const gsdRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const logFile = process.argv[3] ? resolve(process.argv[3]) : join(cwd, ".gsd", "auto-run.log");
const autoLock = join(cwd, ".gsd", "auto.lock");
const stateFile = join(cwd, ".gsd", "STATE.md");
const idleChecksBeforeRelaunch = 3;
const maxConsecutiveRelaunches = 3;

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

async function promptAuto(session, reason) {
  log(`auto-command start reason=${reason}`);
  try {
    await session.prompt("/gsd auto");
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
      allModels.find((m) => m.provider === "anthropic" && m.id === "claude-sonnet-4-6") ||
      allModels.find((m) => m.provider === "anthropic" && m.id.includes("sonnet")) ||
      allModels.find((m) => m.provider === "anthropic");
    if (preferred) {
      settingsManager.setDefaultModelAndProvider(preferred.provider, preferred.id);
    }
  }

  if (settingsManager.getQuietStartup() !== true) settingsManager.setQuietStartup(true);
  if (settingsManager.getCollapseChangelog() !== true) settingsManager.setCollapseChangelog(true);
  if (settingsManager.getDefaultThinkingLevel() !== "off" && !configuredExists) {
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

await ensureRuntimeEnv();
setVersionEnv();
setWorkflowEnv();
process.chdir(cwd);

const cloudPoolSession = await prepareCloudPoolSession(cwd, authFilePath);
const authStorage = cloudPoolSession.authStorage;
loadStoredEnvKeys(authStorage);

const modelRegistry = new ModelRegistry(authStorage);
const settingsManager = SettingsManager.create(agentDir);
applyDefaultModelSettings(settingsManager, modelRegistry, cloudPoolSession.poolActive);

const sessionManager = SessionManager.create(cwd, sessionsDir);
initResources(agentDir);
const resourceLoader = buildResourceLoader(agentDir);
await resourceLoader.reload();

const { session, extensionsResult } = await createAgentSession({
  authStorage,
  modelRegistry,
  settingsManager,
  sessionManager,
  resourceLoader,
});

for (const err of extensionsResult.errors) {
  log(`extension-error ${err.path}: ${err.error}`);
}

session.subscribe((event) => {
  try {
    if (event.type === "message_complete") {
      const text = extractText(event.message?.content);
      if (text) log(`message-complete ${text.replace(/\s+/g, " ").slice(0, 500)}`);
      return;
    }

    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta?.replace(/\s+/g, " ");
      if (delta?.trim()) log(`delta ${delta.slice(0, 200)}`);
      return;
    }

    if (event.type === "tool_call_start") {
      log(`tool-start ${event.toolCall?.name ?? "unknown"}`);
      return;
    }

    if (event.type === "tool_call_complete") {
      log(`tool-complete ${event.toolCall?.name ?? "unknown"}`);
      return;
    }

    if (event.type === "error") {
      log(`error ${event.error?.message ?? "unknown"}`);
    }
  } catch (error) {
    log(`event-log-error ${error instanceof Error ? error.message : String(error)}`);
  }
});

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
    session.dispose();
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
  const streaming = session.isStreaming;
  const state = readStateSnapshot();
  const phase = state?.phase ?? "unknown";
  const activeTask = state?.activeTask ?? "none";
  log(`heartbeat lock=${lockPresent} streaming=${streaming} phase=${phase} task=${activeTask}`);

  if (lockPresent || streaming) {
    settledChecks = 0;
    consecutiveRelaunches = 0;
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
