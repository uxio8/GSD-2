import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import {
  autoCommitCurrentBranch,
  detectWorktreeName,
  ensureSliceBranch,
  findPendingCompletedSliceMerge,
  getActiveSliceBranch,
  getCurrentBranch,
  getSliceBranchName,
  parseSliceBranch,
  SLICE_BRANCH_RE,
  mergeSliceToMain,
  switchToMain,
} from "../worktree.ts";
import { deriveState } from "../state.ts";
import { indexWorkspace } from "../workspace-index.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function run(command: string, cwd: string): string {
  return execSync(command, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

const base = mkdtempSync(join(tmpdir(), "gsd-branch-test-"));
run("git init -b main", base);
run("git config user.name 'Pi Test'", base);
run("git config user.email 'pi@example.com'", base);
mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
writeFileSync(join(base, "README.md"), "hello\n", "utf-8");
writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), `# M001: Demo\n\n## Slices\n- [ ] **S01: Slice One** \`risk:low\` \`depends:[]\`\n  > After this: demo works\n`, "utf-8");
writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "S01-PLAN.md"), `# S01: Slice One\n\n**Goal:** Demo\n**Demo:** Demo\n\n## Must-Haves\n- done\n\n## Tasks\n- [ ] **T01: Implement** \`est:10m\`\n  do it\n`, "utf-8");
run("git add .", base);
run("git commit -m 'chore: init'", base);

async function main(): Promise<void> {
  console.log("\n=== ensureSliceBranch ===");
  const created = ensureSliceBranch(base, "M001", "S01");
  assert(created, "branch created on first ensure");
  assertEq(getCurrentBranch(base), "gsd/M001/S01", "switched to slice branch");

  console.log("\n=== idempotent ensure ===");
  const secondCreate = ensureSliceBranch(base, "M001", "S01");
  assertEq(secondCreate, false, "branch not recreated on second ensure");
  assertEq(getCurrentBranch(base), "gsd/M001/S01", "still on slice branch");

  console.log("\n=== getActiveSliceBranch ===");
  assertEq(getActiveSliceBranch(base), "gsd/M001/S01", "getActiveSliceBranch returns current slice branch");

  console.log("\n=== state surfaces active branch ===");
  const state = await deriveState(base);
  assertEq(state.activeBranch, "gsd/M001/S01", "state exposes active branch");

  console.log("\n=== workspace index surfaces branch ===");
  const index = await indexWorkspace(base);
  const slice = index.milestones[0]?.slices[0];
  assertEq(slice?.branch, "gsd/M001/S01", "workspace index exposes branch");

  console.log("\n=== autoCommitCurrentBranch ===");
  // Clean — should return null
  const cleanResult = autoCommitCurrentBranch(base, "execute-task", "M001/S01/T01");
  assertEq(cleanResult, null, "returns null for clean repo");

  // Make dirty
  writeFileSync(join(base, "dirty.txt"), "uncommitted\n", "utf-8");
  const dirtyResult = autoCommitCurrentBranch(base, "execute-task", "M001/S01/T01");
  assert(dirtyResult !== null, "returns commit message for dirty repo");
  assert(dirtyResult!.includes("M001/S01/T01"), "commit message includes unit id");
  assertEq(run("git status --short", base), "", "repo is clean after auto-commit");

  console.log("\n=== switchToMain ===");
  switchToMain(base);
  assertEq(getCurrentBranch(base), "main", "switched back to main");
  assertEq(getActiveSliceBranch(base), null, "getActiveSliceBranch returns null on main");

  console.log("\n=== mergeSliceToMain ===");
  // Switch back to slice, make a change, switch to main, merge
  ensureSliceBranch(base, "M001", "S01");
  writeFileSync(join(base, "README.md"), "hello from slice\n", "utf-8");
  run("git add README.md", base);
  run("git commit -m 'feat: slice change'", base);
  switchToMain(base);

  const merge = mergeSliceToMain(base, "M001", "S01", "Slice One");
  assertEq(merge.branch, "gsd/M001/S01", "merge reports branch");
  assertEq(merge.targetBranch, "main", "merge reports integration branch");
  assertEq(getCurrentBranch(base), "main", "still on main after merge");
  assert(readFileSync(join(base, "README.md"), "utf-8").includes("slice"), "main got squashed content");
  assert(merge.deletedBranch, "branch was deleted");

  // Verify branch is actually gone
  const branches = run("git branch", base);
  assert(!branches.includes("gsd/M001/S01"), "slice branch no longer exists");

  console.log("\n=== switchToMain auto-commits dirty files ===");
  // Set up S02
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S02", "tasks"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), [
    "# M001: Demo", "", "## Slices",
    "- [x] **S01: Slice One** `risk:low` `depends:[]`", "  > Done",
    "- [ ] **S02: Slice Two** `risk:low` `depends:[]`", "  > Demo 2",
  ].join("\n") + "\n", "utf-8");
  run("git add .", base);
  run("git commit -m 'chore: add S02'", base);

  ensureSliceBranch(base, "M001", "S02");
  writeFileSync(join(base, "feature.txt"), "new feature\n", "utf-8");
  // Don't commit — switchToMain should auto-commit
  switchToMain(base);
  assertEq(getCurrentBranch(base), "main", "switched to main despite dirty files");

  // Verify the commit happened on the slice branch
  ensureSliceBranch(base, "M001", "S02");
  assert(readFileSync(join(base, "feature.txt"), "utf-8").includes("new feature"), "dirty file was committed on slice branch");
  switchToMain(base);

  // Now merge S02
  const mergeS02 = mergeSliceToMain(base, "M001", "S02", "Slice Two");
  assert(readFileSync(join(base, "feature.txt"), "utf-8").includes("new feature"), "main got feature from auto-committed branch");
  assertEq(mergeS02.deletedBranch, true, "S02 branch deleted");
  assertEq(mergeS02.targetBranch, "main", "S02 merged back into main");

  console.log("\n=== getSliceBranchName ===");
  assertEq(getSliceBranchName("M001", "S01"), "gsd/M001/S01", "branch name format correct");
  assertEq(getSliceBranchName("M001", "S01", null), "gsd/M001/S01", "null worktree yields plain branch");
  assertEq(getSliceBranchName("M001", "S01", "demo"), "gsd/demo/M001/S01", "worktree branch is namespaced");

  console.log("\n=== parseSliceBranch ===");
  const plain = parseSliceBranch("gsd/M001/S01");
  assert(plain !== null, "plain slice branch parses");
  assertEq(plain?.worktreeName ?? null, null, "plain slice branch has no worktree");
  assertEq(plain?.milestoneId, "M001", "plain slice branch milestone parsed");
  assertEq(plain?.sliceId, "S01", "plain slice branch slice parsed");

  const namespaced = parseSliceBranch("gsd/demo/M001/S01");
  assert(namespaced !== null, "namespaced slice branch parses");
  assertEq(namespaced?.worktreeName, "demo", "namespaced slice branch worktree parsed");
  assertEq(namespaced?.milestoneId, "M001", "namespaced slice branch milestone parsed");
  assertEq(namespaced?.sliceId, "S01", "namespaced slice branch slice parsed");
  assertEq(parseSliceBranch("main"), null, "non-slice branch does not parse");

  console.log("\n=== SLICE_BRANCH_RE ===");
  assert(SLICE_BRANCH_RE.test("gsd/M001/S01"), "regex matches plain slice branch");
  assert(SLICE_BRANCH_RE.test("gsd/demo/M001/S01"), "regex matches namespaced slice branch");
  assert(!SLICE_BRANCH_RE.test("worktree/demo"), "regex rejects non-slice worktree branch");

  console.log("\n=== detectWorktreeName ===");
  assertEq(detectWorktreeName("/projects/app"), null, "plain path is not a worktree");
  assertEq(detectWorktreeName("/projects/app/.gsd/worktrees/demo"), "demo", "worktree name parsed from root");
  assertEq(detectWorktreeName("/projects/app/.gsd/worktrees/demo/subdir"), "demo", "worktree name parsed from nested path");

  console.log("\n=== ensureSliceBranch rebases existing branch onto updated main ===");
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S03", "tasks"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), [
    "# M001: Demo", "", "## Slices",
    "- [x] **S01: Slice One** `risk:low` `depends:[]`", "  > Done",
    "- [x] **S02: Slice Two** `risk:low` `depends:[]`", "  > Done",
    "- [ ] **S03: Slice Three** `risk:low` `depends:[]`", "  > Demo 3",
  ].join("\n") + "\n", "utf-8");
  run("git add .", base);
  run("git commit -m 'chore: add S03'", base);

  ensureSliceBranch(base, "M001", "S03");
  writeFileSync(join(base, "slice3.txt"), "from slice branch\n", "utf-8");
  run("git add slice3.txt", base);
  run("git commit -m 'feat: s03 branch change'", base);

  switchToMain(base);
  writeFileSync(join(base, "main-only.txt"), "from main\n", "utf-8");
  run("git add main-only.txt", base);
  run("git commit -m 'chore: advance main'", base);

  ensureSliceBranch(base, "M001", "S03");
  assertEq(getCurrentBranch(base), "gsd/M001/S03", "rebase test: checked out S03");
  assert(readFileSync(join(base, "slice3.txt"), "utf-8").includes("slice branch"), "rebase test: kept slice branch commit");
  assert(readFileSync(join(base, "main-only.txt"), "utf-8").includes("from main"), "rebase test: pulled updated main into slice branch");

  console.log("\n=== findPendingCompletedSliceMerge recovers unmerged completed slice ===");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), [
    "# M001: Demo", "", "## Slices",
    "- [x] **S01: Slice One** `risk:low` `depends:[]`", "  > Done",
    "- [x] **S02: Slice Two** `risk:low` `depends:[]`", "  > Done",
    "- [x] **S03: Slice Three** `risk:low` `depends:[]`", "  > Demo 3",
  ].join("\n") + "\n", "utf-8");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S03", "S03-SUMMARY.md"), "# S03 Summary\n", "utf-8");
  run("git add .gsd/milestones/M001/M001-ROADMAP.md .gsd/milestones/M001/slices/S03/S03-SUMMARY.md", base);
  run("git commit -m 'feat: complete S03 on slice branch'", base);

  switchToMain(base);
  const pendingMerge = findPendingCompletedSliceMerge(base, "M001");
  assert(pendingMerge !== null, "findPendingCompletedSliceMerge detects the unmerged completed slice");
  assertEq(pendingMerge?.branch, "gsd/M001/S03", "pending merge reports S03 branch");
  assertEq(pendingMerge?.sliceId, "S03", "pending merge reports S03 slice");

  const recoveredMerge = mergeSliceToMain(
    base,
    pendingMerge!.milestoneId,
    pendingMerge!.sliceId,
    pendingMerge!.sliceTitle,
  );
  assertEq(recoveredMerge.branch, "gsd/M001/S03", "recovered merge uses the completed slice branch");
  assert(readFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S03", "S03-SUMMARY.md"), "utf-8").includes("S03 Summary"), "main received the completed slice summary");
  assertEq(findPendingCompletedSliceMerge(base, "M001"), null, "no pending merge remains after recovery");

  console.log("\n=== findPendingCompletedSliceMerge ignores worktree-namespaced branches ===");
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S98", "tasks"), { recursive: true });
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), [
    "# M001: Demo", "", "## Slices",
    "- [x] **S01: Slice One** `risk:low` `depends:[]`", "  > Done",
    "- [x] **S02: Slice Two** `risk:low` `depends:[]`", "  > Done",
    "- [x] **S03: Slice Three** `risk:low` `depends:[]`", "  > Done",
    "- [ ] **S98: Worktree Only** `risk:low` `depends:[]`", "  > Ignore",
  ].join("\n") + "\n", "utf-8");
  run("git add .gsd/milestones/M001/M001-ROADMAP.md", base);
  run("git commit -m 'chore: add S98 roadmap entry'", base);

  run("git checkout -b gsd/demo/M001/S98", base);
  writeFileSync(join(base, ".gsd", "milestones", "M001", "M001-ROADMAP.md"), [
    "# M001: Demo", "", "## Slices",
    "- [x] **S01: Slice One** `risk:low` `depends:[]`", "  > Done",
    "- [x] **S02: Slice Two** `risk:low` `depends:[]`", "  > Done",
    "- [x] **S03: Slice Three** `risk:low` `depends:[]`", "  > Done",
    "- [x] **S98: Worktree Only** `risk:low` `depends:[]`", "  > Ignore",
  ].join("\n") + "\n", "utf-8");
  writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S98", "S98-SUMMARY.md"), "# S98 Summary\n", "utf-8");
  run("git add .gsd/milestones/M001/M001-ROADMAP.md .gsd/milestones/M001/slices/S98/S98-SUMMARY.md", base);
  run("git commit -m 'feat: complete namespaced slice branch'", base);
  run("git checkout main", base);

  assertEq(findPendingCompletedSliceMerge(base, "M001"), null, "namespaced worktree branch is ignored during pending merge recovery");

  console.log("\n=== worktree anchor branch stays local ===");
  run("git checkout -b worktree/demo", base);
  ensureSliceBranch(base, "M001", "S04");
  assertEq(getCurrentBranch(base), "gsd/M001/S04", "worktree test: checked out S04");
  writeFileSync(join(base, "worktree-only.txt"), "from worktree anchor\n", "utf-8");
  run("git add worktree-only.txt", base);
  run("git commit -m 'feat: worktree slice change'", base);

  switchToMain(base);
  assertEq(getCurrentBranch(base), "worktree/demo", "switchToMain returns to worktree anchor branch");

  const mergeS04 = mergeSliceToMain(base, "M001", "S04", "Slice Four");
  assertEq(mergeS04.targetBranch, "worktree/demo", "S04 merged back into worktree anchor");
  assert(readFileSync(join(base, "worktree-only.txt"), "utf-8").includes("worktree anchor"), "worktree anchor received slice content");

  run("git checkout main", base);
  assert(!existsSync(join(base, "worktree-only.txt")), "main was not polluted by the worktree-only slice");
  run("git checkout worktree/demo", base);

  rmSync(base, { recursive: true, force: true });
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log("All tests passed ✓");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
