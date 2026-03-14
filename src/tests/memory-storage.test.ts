import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MemoryStorage } from "../resources/extensions/memory/storage.ts";

test("memory storage upserts by watermark and can clear per cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-memory-"));
  const dbPath = join(dir, "agent.db");
  const storage = new MemoryStorage(dbPath);

  try {
    const first = storage.upsertThreads([
      {
        threadId: "thread-1",
        filePath: "/tmp/session-1.jsonl",
        fileSize: 10,
        fileMtime: 1000,
        cwd: "/repo/a",
      },
    ]);
    assert.deepEqual(first, { inserted: 1, updated: 0, skipped: 0 });

    const second = storage.upsertThreads([
      {
        threadId: "thread-1",
        filePath: "/tmp/session-1.jsonl",
        fileSize: 10,
        fileMtime: 1000,
        cwd: "/repo/a",
      },
    ]);
    assert.deepEqual(second, { inserted: 0, updated: 0, skipped: 1 });

    storage.completeStage1Job("thread-1", "[]");
    assert.equal(storage.getStats().doneThreads, 1);

    storage.clearForCwd("/repo/a");
    assert.equal(storage.getStats().totalThreads, 0);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
