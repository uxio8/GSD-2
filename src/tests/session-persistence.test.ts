import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("SessionManager externalizes large image blocks and restores them on reload", async () => {
  const { SessionManager } = await import("@mariozechner/pi-coding-agent");
  const dir = mkdtempSync(join(tmpdir(), "session-persist-test-"));
  try {
    const session = SessionManager.create(dir, join(dir, "sessions"));
    const base64 = Buffer.from("image-bytes-".repeat(200)).toString("base64");

    session.appendMessage({
      role: "user",
      content: [{ type: "image", data: base64, mimeType: "image/png" }],
    });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      provider: "openai",
      model: "gpt-test",
      stopReason: "endTurn",
    });

    const sessionFile = session.getSessionFile();
    assert.ok(sessionFile);
    const raw = readFileSync(sessionFile, "utf-8");
    assert.match(raw, /blob:sha256:/);

    const reopened = SessionManager.open(sessionFile, join(dir, "sessions"));
    const context = reopened.buildSessionContext();
    const userMessage = context.messages.find((message) => message.role === "user");
    assert.ok(userMessage);
    assert.ok(Array.isArray(userMessage.content));
    const imageBlock = userMessage.content.find((block: any) => block.type === "image");
    assert.ok(imageBlock);
    assert.equal(imageBlock.data, base64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
