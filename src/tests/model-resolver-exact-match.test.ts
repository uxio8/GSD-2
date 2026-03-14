import test from "node:test";
import assert from "node:assert/strict";

import { getModels } from "@mariozechner/pi-ai";

const { resolveModelScope } = await import(
  new URL("../../node_modules/@mariozechner/pi-coding-agent/dist/core/model-resolver.js?patched", import.meta.url).href,
);

test("anthropic registry exposes claude-opus-4-6[1m]", () => {
  const anthropicModels = getModels("anthropic");
  const oneMillion = anthropicModels.find((model) => model.id === "claude-opus-4-6[1m]");

  assert.ok(oneMillion);
  assert.equal(oneMillion?.contextWindow, 1_000_000);
});

test("resolveModelScope exact-matches ids that contain glob characters", async () => {
  const availableModels = getModels("anthropic").filter((model) =>
    model.id === "claude-opus-4-6[1m]" || model.id === "claude-opus-4-6"
  );
  const scoped = await resolveModelScope(
    ["anthropic/claude-opus-4-6[1m]"],
    { getAvailable: async () => availableModels },
  );

  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]?.model.id, "claude-opus-4-6[1m]");
});
