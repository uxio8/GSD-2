import test from "node:test";
import assert from "node:assert/strict";

import { isLockProcessAlive } from "../crash-recovery.ts";

test("isLockProcessAlive returns true for the current process", () => {
  assert.equal(isLockProcessAlive({
    pid: process.pid,
    startedAt: "",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: "",
    completedUnits: 0,
  }), true);
});

test("isLockProcessAlive returns false for invalid or stale pids", () => {
  assert.equal(isLockProcessAlive({
    pid: -1,
    startedAt: "",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: "",
    completedUnits: 0,
  }), false);
  assert.equal(isLockProcessAlive({
    pid: 999_999_999,
    startedAt: "",
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitStartedAt: "",
    completedUnits: 0,
  }), false);
});
