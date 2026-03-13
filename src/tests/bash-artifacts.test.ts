import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("bash tool emits artifact:// references when truncation spills via ArtifactManager", async () => {
  const { createBashTool, ArtifactManager } = await import("@mariozechner/pi-coding-agent") as any;
  const dir = mkdtempSync(join(tmpdir(), "bash-artifact-test-"));
  try {
    const artifactManager = new ArtifactManager(join(dir, "session.jsonl"));
    const tool = createBashTool(dir, {
      artifactManager,
      operations: {
        async exec(_command: string, _cwd: string, options: { onData: (data: Buffer) => void }) {
          const chunk = Array.from({ length: 8000 }, (_, index) => `line ${index}`).join("\n");
          options.onData(Buffer.from(chunk, "utf-8"));
          options.onData(Buffer.from(chunk, "utf-8"));
          return { exitCode: 0 };
        },
      },
    } as any);

    const result = await tool.execute("tool-1", { command: "echo hi" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(result.details?.artifactId);
    assert.match(String(result.content[0]?.text), /artifact:\/\/0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
