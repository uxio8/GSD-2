import type { AssistantMessageEvent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules } from "./rule-loader.js";
import { TtsrManager, type Rule, type TtsrMatchContext } from "./ttsr-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface PendingViolation {
  rules: Rule[];
}

function buildInterruptContent(rule: Rule): string {
  const template = readFileSync(join(__dirname, "ttsr-interrupt.md"), "utf-8");
  return template
    .replace("{{name}}", rule.name)
    .replace("{{path}}", rule.path)
    .replace("{{content}}", rule.content);
}

function extractDeltaContext(
  event: AssistantMessageEvent,
): { delta: string; context: TtsrMatchContext } | null {
  if (event.type === "text_delta") {
    return {
      delta: event.delta,
      context: { source: "text", streamKey: "text" },
    };
  }

  if (event.type === "thinking_delta") {
    return {
      delta: event.delta,
      context: { source: "thinking", streamKey: "thinking" },
    };
  }

  if (event.type === "toolcall_delta") {
    const partial = event.partial;
    const contentBlock = partial?.content?.[event.contentIndex];
    const toolName = contentBlock && "name" in contentBlock ? (contentBlock as { name?: string }).name : undefined;

    const filePaths: string[] = [];
    if (contentBlock && "partialJson" in contentBlock) {
      const json = (contentBlock as { partialJson?: string }).partialJson;
      if (json) {
        const pathMatch = json.match(/"(?:file_path|path)"\s*:\s*"([^"]+)"/);
        if (pathMatch) filePaths.push(pathMatch[1]);
      }
    }

    return {
      delta: event.delta,
      context: {
        source: "tool",
        toolName,
        filePaths: filePaths.length > 0 ? filePaths : undefined,
        streamKey: `toolcall:${event.contentIndex}`,
      },
    };
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  let manager: TtsrManager | null = null;
  let pendingViolation: PendingViolation | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const rules = loadRules(ctx.cwd);
    if (rules.length === 0) {
      manager = null;
      return;
    }

    manager = new TtsrManager();
    let loaded = 0;
    for (const rule of rules) {
      if (manager.addRule(rule)) loaded++;
    }

    if (loaded === 0) {
      manager = null;
      return;
    }

    const injectedNames = ctx.sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === "ttsr-injected")
      .flatMap((entry) => Array.isArray(entry.data) ? entry.data.filter((value): value is string => typeof value === "string") : []);
    if (injectedNames.length > 0) {
      manager.restoreInjected(injectedNames);
    }
  });

  pi.on("turn_start", async () => {
    if (!manager) return;
    manager.resetBuffer();
    pendingViolation = null;
  });

  pi.on("message_update", async (event, ctx) => {
    if (!manager || !manager.hasRules() || pendingViolation) return;

    const extracted = extractDeltaContext(event.assistantMessageEvent);
    if (!extracted) return;

    const { delta, context } = extracted;
    const matches = manager.checkDelta(delta, context);
    if (matches.length === 0) return;

    pendingViolation = { rules: matches };
    manager.markInjected(matches);
    ctx.abort();
  });

  pi.on("turn_end", async () => {
    if (!manager) return;
    manager.incrementMessageCount();
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!manager || !pendingViolation) return;

    const violation = pendingViolation;
    pendingViolation = null;

    ctx.sessionManager.appendCustomEntry("ttsr-injected", manager.getInjectedRuleNames());

    const interrupt = violation.rules.map(buildInterruptContent).join("\n\n");
    pi.sendMessage(
      {
        customType: "ttsr-violation",
        content: interrupt,
        display: false,
      },
      { triggerTurn: true },
    );
  });
}
