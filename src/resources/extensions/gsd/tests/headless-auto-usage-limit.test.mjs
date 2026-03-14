import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearUsageLimitMarker,
  readUsageLimitMarker,
  resolveUsageLimitWait,
  writeUsageLimitMarker,
} from "../../../../../scripts/headless-auto-usage-limit.mjs";

test("writeUsageLimitMarker persists provider retry windows", () => {
  const project = mkdtempSync(join(tmpdir(), "gsd-usage-limit-"));

  try {
    const marker = writeUsageLimitMarker(project, {
      message: "You have hit your ChatGPT usage limit (team plan). Try again in ~90 min.",
      retryAt: new Date("2026-03-13T18:30:00.000Z"),
    }, new Date("2026-03-13T17:00:00.000Z"));

    assert.equal(marker.retryAt, "2026-03-13T18:30:00.000Z");
    assert.deepEqual(readUsageLimitMarker(project), marker);

    const wait = resolveUsageLimitWait(project, new Date("2026-03-13T17:45:00.000Z"));
    assert.ok(wait);
    assert.equal(wait.retryAt.toISOString(), "2026-03-13T18:30:00.000Z");
    assert.equal(wait.remainingMs, 45 * 60_000);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("writeUsageLimitMarker falls back to a default wait when provider omits retryAt", () => {
  const project = mkdtempSync(join(tmpdir(), "gsd-usage-limit-"));
  const now = new Date("2026-03-13T17:00:00.000Z");

  try {
    const marker = writeUsageLimitMarker(project, {
      message: "You have hit your ChatGPT usage limit (team plan).",
      retryAt: null,
    }, now);

    assert.equal(marker.retryAt, "2026-03-13T17:30:00.000Z");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("clearUsageLimitMarker removes the persisted wait marker", () => {
  const project = mkdtempSync(join(tmpdir(), "gsd-usage-limit-"));

  try {
    writeUsageLimitMarker(project, {
      message: "You have hit your ChatGPT usage limit (team plan). Try again in ~5 min.",
      retryAt: new Date("2026-03-13T17:05:00.000Z"),
    }, new Date("2026-03-13T17:00:00.000Z"));

    clearUsageLimitMarker(project);
    assert.equal(readUsageLimitMarker(project), null);
    assert.equal(resolveUsageLimitWait(project), null);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
