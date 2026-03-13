import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpSession(): { sessionFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "artifact-test-"));
  return {
    sessionFile: join(dir, "session.jsonl"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("ArtifactManager allocates sequential IDs and resumes correctly", async () => {
  const { ArtifactManager } = await import("@mariozechner/pi-coding-agent") as any;
  const { sessionFile, cleanup } = makeTmpSession();
  try {
    const first = new ArtifactManager(sessionFile);
    assert.equal(first.save("output 0", "bash"), "0");
    assert.equal(first.save("output 1", "bash"), "1");

    const resumed = new ArtifactManager(sessionFile);
    const thirdId = resumed.save("output 2", "bash");
    assert.equal(thirdId, "2");
    const path = resumed.getPath(thirdId);
    assert.ok(path);
    assert.equal(readFileSync(path, "utf-8"), "output 2");
  } finally {
    cleanup();
  }
});
