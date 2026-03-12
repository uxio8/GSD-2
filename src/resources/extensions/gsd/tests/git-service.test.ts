import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { GitServiceImpl, inferCommitType } from "../git-service.ts";

function run(command: string, cwd: string): string {
  return execSync(command, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function createRepo(prefix = "gsd-git-service-"): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  run("git init -b main", repo);
  run("git config user.name 'GSD Test'", repo);
  run("git config user.email 'gsd@example.com'", repo);
  writeFileSync(join(repo, "README.md"), "# test\n", "utf-8");
  run("git add README.md", repo);
  run("git commit -m 'chore: init'", repo);
  return repo;
}

function createBareRemote(prefix = "gsd-git-remote-"): string {
  const remote = mkdtempSync(join(tmpdir(), prefix));
  run("git init --bare", remote);
  return remote;
}

test("inferCommitType maps obvious titles to conventional commit types", () => {
  assert.equal(inferCommitType("Fix login redirect bug"), "fix");
  assert.equal(inferCommitType("Refactor task orchestration"), "refactor");
  assert.equal(inferCommitType("Cleanup old artifacts"), "chore");
  assert.equal(inferCommitType("Build milestone summary"), "feat");
});

test("commit smart-stages source changes but excludes GSD runtime files", (t) => {
  const repo = createRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, ".gsd", "activity"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "export const value = 1;\n", "utf-8");
  writeFileSync(join(repo, ".gsd", "STATE.md"), "runtime\n", "utf-8");
  writeFileSync(join(repo, ".gsd", "metrics.json"), "{}\n", "utf-8");
  writeFileSync(join(repo, ".gsd", "activity", "latest.md"), "log\n", "utf-8");

  const svc = new GitServiceImpl(repo);
  const message = svc.commit({ message: "test: smart stage" });

  assert.equal(message, "test: smart stage");
  const names = run("git show --pretty='' --name-only HEAD", repo).split("\n").filter(Boolean);
  assert.deepEqual(names, ["src/app.ts"]);
});

test("ensureSliceBranch preserves the current non-slice integration branch", (t) => {
  const repo = createRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  run("git checkout -b developer", repo);
  writeFileSync(join(repo, "dev.txt"), "developer branch\n", "utf-8");
  run("git add dev.txt", repo);
  run("git commit -m 'chore: developer base'", repo);

  const svc = new GitServiceImpl(repo);
  svc.ensureSliceBranch("M001", "S01");

  assert.equal(run("git branch --show-current", repo), "gsd/M001/S01");
  svc.switchToMain();
  assert.equal(run("git branch --show-current", repo), "developer");
});

test("push_branches pushes newly created slice branches to origin when enabled", (t) => {
  const repo = createRepo();
  const remote = createBareRemote();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  run(`git remote add origin ${JSON.stringify(remote)}`, repo);
  run("git push -u origin main", repo);

  const svc = new GitServiceImpl(repo, { push_branches: true });
  svc.ensureSliceBranch("M001", "S01");

  const remoteRefs = run("git show-ref --heads", remote);
  assert.match(remoteRefs, /refs\/heads\/gsd\/M001\/S01/);
});

test("mergeSliceToMain creates snapshot, rich commit message, and auto-pushes main", (t) => {
  const repo = createRepo();
  const remote = createBareRemote();
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  run(`git remote add origin ${JSON.stringify(remote)}`, repo);
  run("git push -u origin main", repo);

  const svc = new GitServiceImpl(repo, {
    auto_push: true,
    commit_type: "fix",
    pre_merge_check: false,
    snapshots: true,
  });

  svc.ensureSliceBranch("M001", "S01");
  writeFileSync(join(repo, "feature.txt"), "slice change\n", "utf-8");
  run("git add feature.txt", repo);
  run("git commit -m 'feat: add feature file'", repo);

  svc.switchToMain();
  const result = svc.mergeSliceToMain("M001", "S01", "Repair search flow");

  assert.equal(result.mergedCommitMessage, "fix(M001/S01): Repair search flow");

  const commitBody = run("git log -1 --pretty=%B", repo);
  assert.match(commitBody, /^fix\(M001\/S01\): Repair search flow/m);
  assert.match(commitBody, /Tasks:/);
  assert.match(commitBody, /Branch: gsd\/M001\/S01/);

  const refs = run("git for-each-ref refs/gsd/snapshots/ --format='%(refname)'", repo);
  assert.match(refs, /refs\/gsd\/snapshots\/gsd\/M001\/S01\//);

  const remoteMain = run("git log --oneline main -1", remote);
  assert.match(remoteMain, /fix\(M001\/S01\): Repair search flow/);
});

test("mergeSliceToMain resets conflicted squash merges back to a clean tree", (t) => {
  const repo = createRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  writeFileSync(join(repo, "shared.txt"), "main baseline\n", "utf-8");
  run("git add shared.txt", repo);
  run("git commit -m 'chore: add shared file'", repo);

  const svc = new GitServiceImpl(repo, { pre_merge_check: false });

  svc.ensureSliceBranch("M001", "S01");
  writeFileSync(join(repo, "shared.txt"), "slice change\n", "utf-8");
  run("git add shared.txt", repo);
  run("git commit -m 'feat: change from slice branch'", repo);

  svc.switchToMain();
  writeFileSync(join(repo, "shared.txt"), "main change\n", "utf-8");
  run("git add shared.txt", repo);
  run("git commit -m 'feat: change from main branch'", repo);

  assert.throws(
    () => svc.mergeSliceToMain("M001", "S01", "Conflicting merge"),
    /Working tree has been reset to a clean state/,
  );

  assert.equal(run("git status --short", repo), "");
  assert.equal(readFileSync(join(repo, "shared.txt"), "utf-8"), "main change\n");
  assert.equal(run("git branch --show-current", repo), "main");
  assert.match(run("git branch --list gsd/M001/S01", repo), /gsd\/M001\/S01/);
});

test("runPreMergeCheck supports passing and failing custom commands", () => {
  const repo = createRepo();
  try {
    const passing = new GitServiceImpl(repo, { pre_merge_check: "node -e \"process.exit(0)\"" });
    const failing = new GitServiceImpl(repo, { pre_merge_check: "node -e \"process.exit(3)\"" });

    assert.equal(passing.runPreMergeCheck().passed, true);
    const failed = failing.runPreMergeCheck();
    assert.equal(failed.passed, false);
    assert.match(failed.command ?? "", /node -e/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("getMainBranch respects configured main_branch preference", () => {
  const repo = createRepo();
  try {
    const svc = new GitServiceImpl(repo, { main_branch: "trunk" });
    assert.equal(svc.getMainBranch(), "trunk");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
