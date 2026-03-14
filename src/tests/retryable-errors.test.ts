import test from "node:test";
import assert from "node:assert/strict";

const { AgentSession } = await import(
  new URL("../../node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js?patched", import.meta.url).href,
);

function isRetryable(errorMessage: string): boolean {
  return AgentSession.prototype._isRetryableError.call(
    { model: { contextWindow: 200_000 } },
    { stopReason: "error", errorMessage },
  );
}

test("AgentSession treats transient auth and network errors as retryable", () => {
  assert.equal(isRetryable("credentials expired while refreshing token"), true);
  assert.equal(isRetryable("all stored credentials are temporarily backed off"), true);
  assert.equal(isRetryable("network is unavailable during auth refresh"), true);
});
