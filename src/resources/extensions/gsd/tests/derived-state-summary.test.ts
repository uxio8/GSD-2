import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

const repoRoot = process.cwd();
const base = mkdtempSync(join(tmpdir(), "gsd-derived-summary-test-"));
const gsd = join(base, ".gsd");
const m1Dir = join(gsd, "milestones", "M001");
const s1Dir = join(m1Dir, "slices", "S01");
const t1Dir = join(s1Dir, "tasks");
mkdirSync(t1Dir, { recursive: true });
mkdirSync(join(gsd, "milestones", "M002"), { recursive: true });

writeFileSync(join(m1Dir, "M001-ROADMAP.md"), `# M001: Demo Milestone

## Slices
- [ ] **S01: Runtime-heavy slice** \`risk:high\` \`depends:[]\`
  > After this: demo works
`, "utf-8");

writeFileSync(join(s1Dir, "S01-PLAN.md"), `# S01: Runtime-heavy slice

**Goal:** Demo
**Demo:** Demo

## Tasks
- [ ] **T01: Small local tweak** \`est:10m\`
  local
- [ ] **T02: Browser route proof** \`est:1h\`
  route + browser
`, "utf-8");

writeFileSync(join(t1Dir, "T01-PLAN.md"), `---
estimated_steps: 3
estimated_files: 2
---

# T01: Small local tweak

## Steps
1. edit one file
`, "utf-8");

writeFileSync(join(t1Dir, "T02-PLAN.md"), `---
estimated_steps: 12
estimated_files: 9
---

# T02: Browser route proof

## Steps
1. exercise the browser flow

## Observability Impact

- inspect state
`, "utf-8");

writeFileSync(join(gsd, "milestones", "M002", "M002-CONTEXT.md"), `# M002: Future

Not planned yet.
`, "utf-8");

function main(): void {
  console.log("\n=== derived state summary includes pending work ===");

  const output = execFileSync(
    "node",
    [
      "--import",
      join(repoRoot, "src/resources/extensions/gsd/tests/resolve-ts.mjs"),
      "--experimental-strip-types",
      join(repoRoot, "scripts/derived-state-summary.mjs"),
      base,
    ],
    { cwd: repoRoot, encoding: "utf-8" },
  );

  assert(output.includes("derived-overall-progress: 0/2 tasks · 0/1 slices · 0/1 milestones"), "overall progress excludes context-only milestones");
  assert(output.includes("pending-slices-total: 1"), "pending slice count shown");
  assert(output.includes("pending-slice: M001/S01 — Runtime-heavy slice [risk:high] [pending-tasks:2]"), "pending slice line shown");
  assert(output.includes("pending-tasks-total: 2"), "pending task count shown");
  assert(output.includes("pending-task: M001/S01/T01 — Small local tweak [complexity:media]"), "simple local task gets derived complexity");
  assert(output.includes("pending-task: M001/S01/T02 — Browser route proof [complexity:alta]"), "runtime/browser task gets alta complexity");

  rmSync(base, { recursive: true, force: true });
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("All tests passed ✓");
}

main();
