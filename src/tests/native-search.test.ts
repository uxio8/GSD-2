import test from "node:test";
import assert from "node:assert/strict";

import {
  BRAVE_TOOL_NAMES,
  registerNativeSearchHooks,
  stripThinkingFromHistory,
  type NativeSearchPI,
} from "../resources/extensions/search-the-web/native-search.ts";

interface MockHandler {
  event: string;
  handler: (...args: any[]) => any;
}

function createMockPI() {
  const handlers: MockHandler[] = [];
  let activeTools = ["search-the-web", "search_and_read", "fetch_page", "bash"];
  const notifications: Array<{ message: string; level: string }> = [];

  const mockCtx = {
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  const pi: NativeSearchPI & {
    fire(event: string, eventData: any, ctx?: any): Promise<any>;
    getNotifications(): Array<{ message: string; level: string }>;
  } = {
    on(event: string, handler: (...args: any[]) => any) {
      handlers.push({ event, handler });
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
    async fire(event: string, eventData: any, ctx?: any) {
      let lastResult: any;
      for (const handler of handlers) {
        if (handler.event !== event) continue;
        const result = await handler.handler(eventData, ctx ?? mockCtx);
        if (result !== undefined) lastResult = result;
      }
      return lastResult;
    },
    getNotifications() {
      return notifications;
    },
  };

  return pi;
}

test("injects native web_search only when the active provider is Anthropic", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    model: { provider: "anthropic", name: "claude-sonnet-4-6" },
    source: "set",
  });

  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
  };

  const result = await pi.fire("before_provider_request", { payload });
  const tools = ((result as any)?.tools ?? payload.tools) as Array<Record<string, unknown>>;

  assert.equal(
    tools.some((tool) => tool.type === "web_search_20250305"),
    true,
  );
});

test("does not inject native search for Claude-named models served by non-Anthropic providers", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);
  await pi.fire("model_select", {
    model: { provider: "github-copilot", name: "claude-sonnet-4-6" },
    source: "set",
  });

  const payload: Record<string, unknown> = {
    model: "claude-sonnet-4-6-20250514",
    tools: [{ name: "bash", type: "custom" }],
  };

  const result = await pi.fire("before_provider_request", { payload });
  assert.equal(result, undefined);
  assert.equal((payload.tools as Array<unknown>).length, 1);
});

test("removes Brave-backed tools from Claude payload when BRAVE_API_KEY is absent", async () => {
  const original = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;

  try {
    const pi = createMockPI();
    registerNativeSearchHooks(pi);
    await pi.fire("model_select", {
      model: { provider: "anthropic", name: "claude-opus-4-6" },
      source: "set",
    });

    const payload: Record<string, unknown> = {
      model: "claude-opus-4-6-20250514",
      tools: [
        { name: "search-the-web", type: "function" },
        { name: "search_and_read", type: "function" },
        { name: "fetch_page", type: "function" },
      ],
    };

    const result = await pi.fire("before_provider_request", { payload });
    const names = (((result as any)?.tools ?? payload.tools) as Array<{ name?: string }>).map((tool) => tool.name);

    assert.equal(names.includes("search-the-web"), false);
    assert.equal(names.includes("search_and_read"), false);
    assert.equal(names.includes("fetch_page"), true);
    assert.equal(names.includes("web_search"), true);
  } finally {
    if (original) process.env.BRAVE_API_KEY = original;
    else delete process.env.BRAVE_API_KEY;
  }
});

test("re-enabling after provider toggle does not duplicate Brave tool names", async () => {
  const original = process.env.BRAVE_API_KEY;
  delete process.env.BRAVE_API_KEY;

  try {
    const pi = createMockPI();
    registerNativeSearchHooks(pi);

    await pi.fire("model_select", {
      model: { provider: "anthropic", name: "claude-sonnet-4-6" },
      source: "set",
    });
    await pi.fire("model_select", {
      model: { provider: "openai", name: "gpt-5.4" },
      previousModel: { provider: "anthropic", name: "claude-sonnet-4-6" },
      source: "set",
    });
    await pi.fire("model_select", {
      model: { provider: "anthropic", name: "claude-sonnet-4-6" },
      previousModel: { provider: "openai", name: "gpt-5.4" },
      source: "set",
    });
    await pi.fire("model_select", {
      model: { provider: "openai", name: "gpt-5.4" },
      previousModel: { provider: "anthropic", name: "claude-sonnet-4-6" },
      source: "set",
    });

    const active = pi.getActiveTools();
    assert.equal(active.filter((tool) => tool === "search-the-web").length, 1);
    assert.equal(active.filter((tool) => tool === "search_and_read").length, 1);
  } finally {
    if (original) process.env.BRAVE_API_KEY = original;
    else delete process.env.BRAVE_API_KEY;
  }
});

test("suppresses native-search activation notification during restore", async () => {
  const pi = createMockPI();
  registerNativeSearchHooks(pi);

  await pi.fire("model_select", {
    model: { provider: "anthropic", name: "claude-sonnet-4-6" },
    source: "restore",
  });

  assert.equal(
    pi.getNotifications().some((note) => note.message.includes("Native Anthropic web search active")),
    false,
  );
});

test("stripThinkingFromHistory removes Anthropic thinking blocks from assistant history", () => {
  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", signature: "sig-1" },
        { type: "text", text: "Hello" },
      ],
    },
  ];

  stripThinkingFromHistory(messages);

  assert.deepEqual(messages[1]?.content, [{ type: "text", text: "Hello" }]);
  assert.deepEqual(BRAVE_TOOL_NAMES, ["search-the-web", "search_and_read"]);
});
