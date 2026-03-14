import test from "node:test";
import assert from "node:assert/strict";

import { SettingsManager } from "@mariozechner/pi-coding-agent";

test("memory settings default to disabled and safe limits", () => {
  const manager = SettingsManager.inMemory({});
  assert.deepEqual(manager.getMemorySettings(), {
    enabled: false,
    maxRolloutsPerStartup: 64,
    maxRolloutAgeDays: 30,
    minRolloutIdleHours: 12,
    stage1Concurrency: 8,
    summaryInjectionTokenLimit: 5000,
  });
});

test("memory settings read explicit overrides", () => {
  const manager = SettingsManager.inMemory({
    memory: {
      enabled: true,
      maxRolloutsPerStartup: 12,
      maxRolloutAgeDays: 7,
      minRolloutIdleHours: 2,
      stage1Concurrency: 3,
      summaryInjectionTokenLimit: 1500,
    },
  });

  assert.deepEqual(manager.getMemorySettings(), {
    enabled: true,
    maxRolloutsPerStartup: 12,
    maxRolloutAgeDays: 7,
    minRolloutIdleHours: 2,
    stage1Concurrency: 3,
    summaryInjectionTokenLimit: 1500,
  });
});
