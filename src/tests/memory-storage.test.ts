import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MemoryStorage } from "../resources/extensions/memory/storage.ts";

test("memory storage upserts by watermark and can clear per cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-memory-"));
  const dbPath = join(dir, "agent.db");
  const storage = await MemoryStorage.create(dbPath);

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

test("memory storage persists stage1 and stage2 workflow across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-memory-reopen-"));
  const dbPath = join(dir, "agent.db");
  const storage = await MemoryStorage.create(dbPath);

  try {
    const upsert = storage.upsertThreads([
      {
        threadId: "thread-1",
        filePath: "/tmp/session-1.jsonl",
        fileSize: 10,
        fileMtime: 1000,
        cwd: "/repo/a",
      },
      {
        threadId: "thread-2",
        filePath: "/tmp/session-2.jsonl",
        fileSize: 20,
        fileMtime: 2000,
        cwd: "/repo/b",
      },
    ]);
    assert.deepEqual(upsert, { inserted: 2, updated: 0, skipped: 0 });

    const claimed = storage.claimStage1Jobs("worker-1", 8, 30);
    assert.equal(claimed.length, 2);

    storage.completeStage1Job("thread-1", "[{\"memory\":\"one\"}]");
    storage.failStage1Job("thread-2", "boom");

    const statsAfterStage1 = storage.getStats();
    assert.equal(statsAfterStage1.doneThreads, 1);
    assert.equal(statsAfterStage1.errorThreads, 1);
    assert.equal(statsAfterStage1.pendingStage1Jobs, 0);

    const phase2 = storage.tryClaimGlobalPhase2Job("worker-2", 30);
    assert.ok(phase2);
    storage.completePhase2Job(phase2!.jobId);

    storage.resetAllForCwd("/repo/a");
    const statsAfterReset = storage.getStats();
    assert.equal(statsAfterReset.pendingThreads, 1);
    assert.equal(statsAfterReset.totalStage1Outputs, 0);
  } finally {
    storage.close();
  }

  const reopened = await MemoryStorage.create(dbPath);
  try {
    const thread = reopened.getThread("thread-1");
    assert.equal(thread?.status, "pending");
    assert.deepEqual(reopened.getStage1OutputsForCwd("/repo/a"), []);
    assert.equal(reopened.getStats().totalThreads, 2);
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
