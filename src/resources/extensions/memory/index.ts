import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getFullMemory, getMemorySummary, runStartup } from "./pipeline.js";
import { MemoryStorage } from "./storage.js";

function encodeCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function getMemoryDir(cwd: string): string {
  return join(getAgentDir(), "memories", encodeCwd(cwd));
}

function getDbPath(): string {
  return join(getAgentDir(), "agent.db");
}

let storageInstance: MemoryStorage | null = null;

function getStorage(): MemoryStorage {
  if (!storageInstance) {
    storageInstance = new MemoryStorage(getDbPath());
  }
  return storageInstance;
}

export default function memoryExtension(api: ExtensionAPI): void {
  const defaults = {
    enabled: false,
    maxRolloutsPerStartup: 64,
    maxRolloutAgeDays: 30,
    minRolloutIdleHours: 12,
    stage1Concurrency: 8,
    summaryInjectionTokenLimit: 5000,
  };

  let memorySettings = defaults;
  try {
    memorySettings = SettingsManager.create().getMemorySettings();
  } catch {
    memorySettings = defaults;
  }

  let cwd = "";
  let memoryDir = "";

  api.registerCommand("memory", {
    description: memorySettings.enabled
      ? "View or manage extracted project memories"
      : "Memory extraction pipeline (disabled - enable in settings)",
    getArgumentCompletions(prefix) {
      const subcommands = [
        { label: "view", description: "View current memories (default)" },
        { label: "clear", description: "Clear all memories for this project" },
        { label: "rebuild", description: "Re-extract all memories" },
        { label: "stats", description: "Show pipeline statistics" },
      ];
      return subcommands
        .filter((command) => command.label.startsWith(prefix))
        .map((command) => ({
          value: command.label,
          label: command.label,
          description: command.description,
        }));
    },
    async handler(args, ctx) {
      if (!memorySettings.enabled) {
        ctx.ui.notify(
          'Memory extraction is disabled. Enable it with: settings.json -> "memory": { "enabled": true }',
          "info",
        );
        return;
      }

      const subcommand = args.trim().split(/\s+/)[0] || "view";
      const projectMemoryDir = getMemoryDir(ctx.cwd);

      switch (subcommand) {
        case "view": {
          const memory = getFullMemory(projectMemoryDir);
          if (!memory) {
            ctx.ui.notify(
              "No memories extracted yet. Memories are extracted on session startup.",
              "info",
            );
            return;
          }
          api.sendMessage({ customType: "memory:view", content: memory, display: true });
          return;
        }
        case "clear": {
          const confirmed = await ctx.ui.confirm(
            "Clear Memories",
            "Delete all extracted memories for this project?",
          );
          if (confirmed) {
            getStorage().clearForCwd(ctx.cwd);
            if (existsSync(projectMemoryDir)) {
              rmSync(projectMemoryDir, { recursive: true, force: true });
            }
            ctx.ui.notify("Memories cleared.", "info");
          }
          return;
        }
        case "rebuild": {
          const confirmed = await ctx.ui.confirm(
            "Rebuild Memories",
            "Re-extract all memories from session history? This may take a while.",
          );
          if (confirmed) {
            getStorage().resetAllForCwd(ctx.cwd);
            if (existsSync(projectMemoryDir)) {
              rmSync(projectMemoryDir, { recursive: true, force: true });
            }
            ctx.ui.notify(
              "Memory rebuild enqueued. Extraction will run on next session startup.",
              "info",
            );
          }
          return;
        }
        case "stats": {
          const stats = getStorage().getStats();
          api.sendMessage({
            customType: "memory:stats",
            content: [
              "Memory Pipeline Statistics:",
              `  Total sessions tracked: ${stats.totalThreads}`,
              `  Pending extraction: ${stats.pendingThreads}`,
              `  Extracted: ${stats.doneThreads}`,
              `  Errors: ${stats.errorThreads}`,
              `  Stage 1 outputs: ${stats.totalStage1Outputs}`,
              `  Pending stage 1 jobs: ${stats.pendingStage1Jobs}`,
              `  Memory dir: ${projectMemoryDir}`,
              `  Memory exists: ${existsSync(join(projectMemoryDir, "MEMORY.md"))}`,
            ].join("\n"),
            display: true,
          });
          return;
        }
        default:
          ctx.ui.notify(
            `Unknown subcommand: ${subcommand}. Use: view, clear, rebuild, stats`,
            "warning",
          );
      }
    },
  });

  if (!memorySettings.enabled) {
    return;
  }

  api.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    memoryDir = getMemoryDir(cwd);
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    const model = ctx.model;
    if (!model) {
      return;
    }

    const llmCall = async (
      system: string,
      user: string,
      options?: { maxTokens?: number },
    ): Promise<string> => {
      const result = await completeSimple(
        model,
        {
          systemPrompt: system,
          messages: [{ role: "user", content: user, timestamp: Date.now() }],
        },
        { maxTokens: options?.maxTokens ?? 4096 },
      );
      return result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
    };

    runStartup(
      getStorage(),
      {
        sessionsDir: join(getAgentDir(), "sessions"),
        memoryDir,
        cwd,
        maxRolloutsPerStartup: memorySettings.maxRolloutsPerStartup,
        maxRolloutAgeDays: memorySettings.maxRolloutAgeDays,
        minRolloutIdleHours: memorySettings.minRolloutIdleHours,
        stage1Concurrency: memorySettings.stage1Concurrency,
      },
      llmCall,
    ).catch(() => {
      // Best-effort only.
    });
  });

  api.on("before_agent_start", async (event, ctx) => {
    if (!memoryDir) {
      memoryDir = getMemoryDir(ctx.cwd);
    }

    const summary = getMemorySummary(memoryDir);
    if (!summary) {
      return;
    }

    const charLimit = memorySettings.summaryInjectionTokenLimit * 4;
    const truncated = summary.length > charLimit
      ? `${summary.slice(0, charLimit)}\n[...truncated]`
      : summary;
    return { systemPrompt: `${event.systemPrompt}\n\n${truncated}` };
  });

  api.on("session_shutdown", async () => {
    if (storageInstance) {
      storageInstance.close();
      storageInstance = null;
    }
  });
}
