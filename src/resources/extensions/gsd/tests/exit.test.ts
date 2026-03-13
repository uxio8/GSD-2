import test from "node:test";
import assert from "node:assert/strict";

import { exitGracefully, killImmediately } from "../exit.ts";

test("exitGracefully stops auto-mode before exiting", async () => {
  const calls: string[] = [];

  await exitGracefully({} as any, {} as any, {
    stopAutoFn: async () => { calls.push("stop"); },
    exitFn: () => { calls.push("exit"); },
  });

  assert.deepEqual(calls, ["stop", "exit"]);
});

test("killImmediately exits without cleanup", () => {
  const calls: string[] = [];
  killImmediately(() => { calls.push("exit"); });
  assert.deepEqual(calls, ["exit"]);
});
