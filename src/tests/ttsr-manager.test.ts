import test from "node:test";
import assert from "node:assert/strict";
import { TtsrManager, type Rule, type TtsrMatchContext } from "../resources/extensions/ttsr/ttsr-manager.ts";

function makeRule(overrides: Partial<Rule> = {}): Rule {
  return {
    name: "test-rule",
    path: "/test/rules/test-rule.md",
    content: "Do not do this.",
    condition: ["console\\.log"],
    ...overrides,
  };
}

function textCtx(streamKey?: string): TtsrMatchContext {
  return { source: "text", streamKey: streamKey ?? "text" };
}

function toolCtx(toolName?: string, filePaths?: string[]): TtsrMatchContext {
  return { source: "tool", toolName, filePaths, streamKey: toolName ? `tool:${toolName}` : "tool" };
}

function thinkingCtx(): TtsrMatchContext {
  return { source: "thinking", streamKey: "thinking" };
}

test("TtsrManager matches text deltas and buffers across chunks", () => {
  const manager = new TtsrManager();
  manager.addRule(makeRule());
  assert.equal(manager.checkDelta("console", textCtx()).length, 0);
  assert.equal(manager.checkDelta(".log('x')", textCtx()).length, 1);
});

test("TtsrManager honors scope filtering", () => {
  const manager = new TtsrManager();
  manager.addRule(makeRule({ scope: ["tool:edit"] }));
  assert.equal(manager.checkDelta("console.log", textCtx()).length, 0);
  assert.equal(manager.checkDelta("console.log", toolCtx("edit")).length, 1);
  assert.equal(manager.checkDelta("console.log", thinkingCtx()).length, 0);
});

test("TtsrManager repeat gating and restoreInjected work", () => {
  const manager = new TtsrManager({ repeatMode: "once" });
  manager.addRule(makeRule());
  const first = manager.checkDelta("console.log", textCtx());
  assert.equal(first.length, 1);
  manager.markInjected(first);
  manager.resetBuffer();
  assert.equal(manager.checkDelta("console.log", textCtx()).length, 0);

  const restored = new TtsrManager({ repeatMode: "once" });
  restored.addRule(makeRule());
  restored.restoreInjected(["test-rule"]);
  assert.equal(restored.checkDelta("console.log", textCtx()).length, 0);
});

test("TtsrManager isolates buffers and applies glob filtering", () => {
  const manager = new TtsrManager();
  manager.addRule(makeRule({ name: "path-rule", condition: ["TODO"], globs: ["*.ts"], scope: ["tool:edit"] }));

  assert.equal(manager.checkDelta("TODO", toolCtx("edit", ["README.md"])).length, 0);
  manager.resetBuffer();
  assert.equal(manager.checkDelta("TODO", toolCtx("edit", ["src/index.ts"])).length, 1);
});
