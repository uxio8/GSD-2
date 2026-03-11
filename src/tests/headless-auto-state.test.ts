import test from "node:test";
import assert from "node:assert/strict";

import { parseStateSnapshot, isTerminalState } from "../../scripts/headless-auto-state.mjs";

test("parseStateSnapshot reads the dashboard summary fields", () => {
  const snapshot = parseStateSnapshot(`# GSD State

**Active Milestone:** M001 — Demo
**Active Slice:** S04 — Hardening
**Active Task:** T04 — Final acceptance
**Phase:** in_progress
**Next Action:** Run the full verification stack.
`);

  assert.deepEqual(snapshot, {
    activeMilestone: "M001 — Demo",
    activeSlice: "S04 — Hardening",
    activeTask: "T04 — Final acceptance",
    phase: "in_progress",
    nextAction: "Run the full verification stack.",
  });
});

test("isTerminalState only closes on true terminal milestones", () => {
  assert.equal(isTerminalState({
    activeMilestone: "M001 — Demo",
    activeSlice: "S04 — Hardening",
    activeTask: "T04 — Final acceptance",
    phase: "in_progress",
    nextAction: "Run the full verification stack.",
  }), false);

  assert.equal(isTerminalState({
    activeMilestone: "M001 — Demo",
    activeSlice: "S03 — Complete slice",
    activeTask: null,
    phase: "completed",
    nextAction: "Await the next milestone or slice assignment; S03/T04 verification and documentation are complete.",
  }), false);

  assert.equal(isTerminalState({
    activeMilestone: "M001 — Demo",
    activeSlice: null,
    activeTask: null,
    phase: "complete",
    nextAction: "All milestones complete.",
  }), true);
});
