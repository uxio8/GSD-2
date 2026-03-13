import test from "node:test";
import assert from "node:assert/strict";

import { SessionManager } from "@mariozechner/pi-coding-agent";
import { createProjectSessionManager, getProjectSessionsDir, parseCliArgs } from "../cli-support.ts";

test("parseCliArgs recognizes --continue and -c", () => {
  const longFlag = parseCliArgs(["node", "gsd", "--continue", "hello"]);
  const shortFlag = parseCliArgs(["node", "gsd", "-c"]);

  assert.equal(longFlag.continue, true);
  assert.deepEqual(longFlag.messages, ["hello"]);
  assert.equal(shortFlag.continue, true);
});

test("createProjectSessionManager uses continueRecent when requested", () => {
  const cwd = "/tmp/gsd-cli-support";
  const sessionDir = getProjectSessionsDir(cwd);
  const originalCreate = SessionManager.create;
  const originalContinueRecent = SessionManager.continueRecent;
  const calls: Array<{ method: string; cwd: string; sessionDir: string }> = [];

  (SessionManager as any).create = (capturedCwd: string, capturedSessionDir: string) => {
    calls.push({ method: "create", cwd: capturedCwd, sessionDir: capturedSessionDir });
    return { kind: "create" };
  };
  (SessionManager as any).continueRecent = (capturedCwd: string, capturedSessionDir: string) => {
    calls.push({ method: "continueRecent", cwd: capturedCwd, sessionDir: capturedSessionDir });
    return { kind: "continueRecent" };
  };

  try {
    const resumed = createProjectSessionManager(cwd, { continueRecent: true }) as any;
    const created = createProjectSessionManager(cwd) as any;

    assert.equal(resumed.kind, "continueRecent");
    assert.equal(created.kind, "create");
    assert.deepEqual(calls, [
      { method: "continueRecent", cwd, sessionDir },
      { method: "create", cwd, sessionDir },
    ]);
  } finally {
    (SessionManager as any).create = originalCreate;
    (SessionManager as any).continueRecent = originalContinueRecent;
  }
});
