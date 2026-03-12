/**
 * Native Anthropic web search hook logic.
 *
 * Extracted from index.ts so it can be unit-tested without importing
 * the heavier tool registration modules.
 */

export const BRAVE_TOOL_NAMES = ["search-the-web", "search_and_read"];

const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

export interface NativeSearchPI {
  on(event: string, handler: (...args: any[]) => any): void;
  getActiveTools(): string[];
  setActiveTools(tools: string[]): void;
}

export function stripThinkingFromHistory(messages: Array<Record<string, unknown>>): void {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;

    const content = msg.content;
    if (!Array.isArray(content)) continue;

    msg.content = content.filter((block: any) => !THINKING_TYPES.has(block?.type));
  }
}

export function registerNativeSearchHooks(pi: NativeSearchPI): { getIsAnthropic: () => boolean } {
  let isAnthropicProvider = false;

  pi.on("model_select", async (event: any, ctx: any) => {
    const wasAnthropic = isAnthropicProvider;
    isAnthropicProvider = event.model.provider === "anthropic";

    const hasBrave = !!process.env.BRAVE_API_KEY;

    if (isAnthropicProvider && !hasBrave) {
      const active = pi.getActiveTools();
      pi.setActiveTools(active.filter((tool) => !BRAVE_TOOL_NAMES.includes(tool)));
    } else if (!isAnthropicProvider && wasAnthropic && !hasBrave) {
      const active = pi.getActiveTools();
      const toAdd = BRAVE_TOOL_NAMES.filter((tool) => !active.includes(tool));
      if (toAdd.length > 0) {
        pi.setActiveTools([...active, ...toAdd]);
      }
    }

    if (isAnthropicProvider && !wasAnthropic && event.source !== "restore") {
      ctx.ui.notify("Native Anthropic web search active", "info");
    } else if (!isAnthropicProvider && !hasBrave) {
      ctx.ui.notify(
        "Web search: Set BRAVE_API_KEY or use an Anthropic model for built-in search",
        "warning",
      );
    }
  });

  pi.on("before_provider_request", (event: any) => {
    const payload = event.payload as Record<string, unknown>;
    if (!payload) return;

    const model = payload.model as string | undefined;
    if (!model || !model.startsWith("claude")) return;

    isAnthropicProvider = true;

    const messages = payload.messages as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(messages)) {
      stripThinkingFromHistory(messages);
    }

    if (!Array.isArray(payload.tools)) payload.tools = [];

    let tools = payload.tools as Array<Record<string, unknown>>;
    if (tools.some((tool) => tool.type === "web_search_20250305")) return;

    const hasBrave = !!process.env.BRAVE_API_KEY;
    if (!hasBrave) {
      tools = tools.filter((tool) => !BRAVE_TOOL_NAMES.includes(tool.name as string));
      payload.tools = tools;
    }

    tools.push({
      type: "web_search_20250305",
      name: "web_search",
    });

    return payload;
  });

  pi.on("session_start", async (_event: any, ctx: any) => {
    const hasBrave = !!process.env.BRAVE_API_KEY;
    const hasJina = !!process.env.JINA_API_KEY;
    const hasAnswers = !!process.env.BRAVE_ANSWERS_KEY;
    const hasTavily = !!process.env.TAVILY_API_KEY;

    const parts: string[] = ["Web search v4 loaded"];
    if (hasTavily) parts.push("Tavily ✓");
    if (hasBrave) parts.push("Brave ✓");
    if (hasAnswers) parts.push("Answers ✓");
    if (hasJina) parts.push("Jina ✓");

    ctx.ui.notify(parts.join(" · "), "info");
  });

  return { getIsAnthropic: () => isAnthropicProvider };
}
