import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runGSDDoctor } from "../doctor.js";

test("runGSDDoctor fixLevel task does not preempt complete-slice transitions", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-fixlevel-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  const tasksDir = join(sliceDir, "tasks");
  mkdirSync(tasksDir, { recursive: true });

  writeFileSync(join(milestoneDir, "M001-ROADMAP.md"), `# M001: Test Milestone

## Slices
- [ ] **S01: Demo Slice** \`risk:low\` \`depends:[]\`
  > After this: demo works
`, "utf-8");

  writeFileSync(join(sliceDir, "S01-PLAN.md"), `# S01: Demo Slice

**Goal:** Demo
**Demo:** Demo

## Tasks
- [x] **T01: Implement thing** \`est:10m\`
  Done.
`, "utf-8");

  writeFileSync(join(tasksDir, "T01-SUMMARY.md"), `---
id: T01
parent: S01
milestone: M001
---
# T01: Implement thing

**Done**

## What Happened
Implemented.
`, "utf-8");

  const report = await runGSDDoctor(base, {
    fix: true,
    scope: "M001/S01",
    fixLevel: "task",
  });

  assert.equal(report.fixesApplied.length, 0);
  assert.equal(existsSync(join(sliceDir, "S01-SUMMARY.md")), false);
  assert.equal(existsSync(join(sliceDir, "S01-UAT.md")), false);

  const roadmap = readFileSync(join(milestoneDir, "M001-ROADMAP.md"), "utf-8");
  assert.match(roadmap, /- \[ \] \*\*S01:/);
});
