/**
 * GSD Git Service
 *
 * Centralizes git operations used by GSD auto-mode and worktree helpers.
 * This keeps staging rules, branch selection, commit formatting, and merge
 * checks consistent across the extension.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import {
  detectWorktreeName,
  getSliceBranchName,
  SLICE_BRANCH_RE,
} from "./worktree.ts";

export interface GitPreferences {
  auto_push?: boolean;
  push_branches?: boolean;
  remote?: string;
  snapshots?: boolean;
  pre_merge_check?: boolean | string;
  commit_type?: string;
  main_branch?: string;
}

export const VALID_BRANCH_NAME = /^[a-zA-Z0-9_\-/.]+$/;

export interface CommitOptions {
  message: string;
  allowEmpty?: boolean;
}

export interface MergeSliceResult {
  branch: string;
  mergedCommitMessage: string;
  deletedBranch: boolean;
}

export class MergeConflictError extends Error {
  readonly conflictedFiles: string[];
  readonly strategy: "squash";
  readonly branch: string;
  readonly mainBranch: string;

  constructor(
    conflictedFiles: string[],
    branch: string,
    mainBranch: string,
  ) {
    super(
      `Squash-merge of "${branch}" into "${mainBranch}" failed with conflicts in `
      + `${conflictedFiles.length} non-runtime file(s): ${conflictedFiles.join(", ")}`,
    );
    this.name = "MergeConflictError";
    this.conflictedFiles = conflictedFiles;
    this.strategy = "squash";
    this.branch = branch;
    this.mainBranch = mainBranch;
  }
}

export interface PreMergeCheckResult {
  passed: boolean;
  skipped?: boolean;
  command?: string;
  error?: string;
}

/**
 * Runtime/generated GSD files that should never be staged by smart commits.
 */
export const RUNTIME_EXCLUSION_PATHS: readonly string[] = [
  ".gsd/activity/",
  ".gsd/runtime/",
  ".gsd/worktrees/",
  ".gsd/auto.lock",
  ".gsd/metrics.json",
  ".gsd/STATE.md",
];

/**
 * Durable planning artifacts that must still be staged even when a project
 * ignores `.gsd/` broadly. Runtime files remain excluded by the reset pass.
 */
const GSD_DURABLE_PATHS: readonly string[] = [
  ".gsd/milestones/",
  ".gsd/DECISIONS.md",
  ".gsd/QUEUE.md",
  ".gsd/PROJECT.md",
  ".gsd/REQUIREMENTS.md",
];

export function runGit(
  basePath: string,
  args: string[],
  options: { allowFailure?: boolean; input?: string } = {},
): string {
  try {
    return execFileSync("git", args, {
      cwd: basePath,
      stdio: [options.input != null ? "pipe" : "ignore", "pipe", "pipe"],
      encoding: "utf-8",
      ...(options.input != null ? { input: options.input } : {}),
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed in ${basePath}: ${message}`);
  }
}

const COMMIT_TYPE_RULES: [string[], string][] = [
  [["fix", "bug", "patch", "hotfix"], "fix"],
  [["refactor", "restructure", "reorganize"], "refactor"],
  [["doc", "docs", "documentation"], "docs"],
  [["test", "tests", "testing"], "test"],
  [["chore", "cleanup", "clean up", "archive", "remove", "delete"], "chore"],
];

function normalizeRuntimeExclusionPath(path: string): string {
  return path.replace(/\/+$/, "");
}

function isRuntimeConflictPath(path: string): boolean {
  const normalized = normalizeRuntimeExclusionPath(path);
  return RUNTIME_EXCLUSION_PATHS.some((exclusion) => {
    const normalizedExclusion = normalizeRuntimeExclusionPath(exclusion);
    return normalized === normalizedExclusion || normalized.startsWith(`${normalizedExclusion}/`);
  });
}

export class GitServiceImpl {
  readonly basePath: string;
  readonly prefs: GitPreferences;

  constructor(basePath: string, prefs: GitPreferences = {}) {
    this.basePath = basePath;
    this.prefs = prefs;
  }

  private git(args: string[], options: { allowFailure?: boolean; input?: string } = {}): string {
    return runGit(this.basePath, args, options);
  }

  private smartStage(extraExclusions: readonly string[] = []): void {
    const allExclusions = [...RUNTIME_EXCLUSION_PATHS, ...extraExclusions];
    const excludes = allExclusions.map((path) => `:(exclude)${path}`);
    try {
      this.git(["add", "-A", "--", ".", ...excludes]);
    } catch {
      console.error("GitService: smart staging failed, falling back to git add -A");
      this.git(["add", "-A"]);
    }

    for (const durablePath of GSD_DURABLE_PATHS) {
      this.git(["add", "--force", "--", durablePath], { allowFailure: true });
    }

    for (const exclusion of allExclusions) {
      this.git(["reset", "HEAD", "--", exclusion], { allowFailure: true });
    }
  }

  private push(branch: string, options: { setUpstream?: boolean } = {}): void {
    const remote = this.prefs.remote ?? "origin";
    const args = ["push", ...(options.setUpstream ? ["-u"] : []), remote, branch];
    this.git(args, { allowFailure: true });
  }

  commit(opts: CommitOptions): string | null {
    this.smartStage();
    const staged = this.git(["diff", "--cached", "--stat"], { allowFailure: true });
    if (!staged && !opts.allowEmpty) return null;

    this.git(
      ["commit", "-F", "-", ...(opts.allowEmpty ? ["--allow-empty"] : [])],
      { input: opts.message },
    );

    if (this.prefs.auto_push === true) {
      const branch = this.getCurrentBranch();
      if (branch) this.push(branch);
    }

    return opts.message;
  }

  autoCommit(unitType: string, unitId: string, extraExclusions: readonly string[] = []): string | null {
    const status = this.git(["status", "--short"], { allowFailure: true });
    if (!status) return null;

    this.smartStage(extraExclusions);
    const staged = this.git(["diff", "--cached", "--stat"], { allowFailure: true });
    if (!staged) return null;

    const message = `chore(${unitId}): auto-commit after ${unitType}`;
    this.git(["commit", "-F", "-"], { input: message });

    if (this.prefs.auto_push === true) {
      const branch = this.getCurrentBranch();
      if (branch) this.push(branch);
    }

    return message;
  }

  getMainBranch(): string {
    const wtName = detectWorktreeName(this.basePath);
    if (wtName) {
      const wtBranch = `worktree/${wtName}`;
      const exists = this.git(["show-ref", "--verify", `refs/heads/${wtBranch}`], { allowFailure: true });
      if (exists) return wtBranch;
      return this.git(["branch", "--show-current"]);
    }

    const configured = this.prefs.main_branch;
    if (configured && VALID_BRANCH_NAME.test(configured)) {
      return configured;
    }

    const symbolic = this.git(["symbolic-ref", "refs/remotes/origin/HEAD"], { allowFailure: true });
    if (symbolic) {
      const match = symbolic.match(/refs\/remotes\/origin\/(.+)$/);
      if (match) return match[1]!;
    }

    const mainExists = this.git(["show-ref", "--verify", "refs/heads/main"], { allowFailure: true });
    if (mainExists) return "main";

    const masterExists = this.git(["show-ref", "--verify", "refs/heads/master"], { allowFailure: true });
    if (masterExists) return "master";

    return this.git(["branch", "--show-current"]);
  }

  getCurrentBranch(): string {
    return this.git(["branch", "--show-current"]);
  }

  isOnSliceBranch(): boolean {
    return SLICE_BRANCH_RE.test(this.getCurrentBranch());
  }

  getActiveSliceBranch(): string | null {
    try {
      const current = this.getCurrentBranch();
      return SLICE_BRANCH_RE.test(current) ? current : null;
    } catch {
      return null;
    }
  }

  private resolveGitDir(): string {
    const gitDir = this.git(["rev-parse", "--git-dir"]);
    return gitDir.startsWith("/") ? gitDir : resolve(this.basePath, gitDir);
  }

  private integrationBranchPath(): string {
    return join(this.resolveGitDir(), "gsd-integration-branch");
  }

  private readIntegrationBranch(): string | null {
    try {
      const branch = readFileSync(this.integrationBranchPath(), "utf-8").trim();
      return branch || null;
    } catch {
      return null;
    }
  }

  private writeIntegrationBranch(branch: string): void {
    if (!branch || SLICE_BRANCH_RE.test(branch)) return;
    try {
      writeFileSync(this.integrationBranchPath(), `${branch}\n`, "utf-8");
    } catch {
      // Best-effort cache only.
    }
  }

  getIntegrationBranch(): string {
    const current = this.getCurrentBranch();
    if (current && !SLICE_BRANCH_RE.test(current)) {
      this.writeIntegrationBranch(current);
      return current;
    }

    const persisted = this.readIntegrationBranch();
    if (persisted) return persisted;

    const fallback = this.getMainBranch();
    this.writeIntegrationBranch(fallback);
    return fallback;
  }

  private branchExists(branch: string): boolean {
    try {
      this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private untrackRuntimeFilesBeforeMerge(): void {
    const trackedRuntimeFiles = this.git(["ls-files", "--", ...RUNTIME_EXCLUSION_PATHS.map(normalizeRuntimeExclusionPath)], { allowFailure: true })
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const exclusion of RUNTIME_EXCLUSION_PATHS) {
      const normalized = normalizeRuntimeExclusionPath(exclusion);
      this.git(["rm", "--cached", "-r", "--ignore-unmatch", "--", normalized], { allowFailure: true });
    }

    const staged = this.git(["diff", "--cached", "--stat"], { allowFailure: true });
    if (!staged) return;

    this.git(["commit", "-m", "chore: untrack .gsd runtime files before merge"], { allowFailure: true });

    for (const file of trackedRuntimeFiles) {
      const absolute = join(this.basePath, file);
      if (!existsSync(absolute)) continue;
      rmSync(absolute, { recursive: true, force: true });
    }
  }

  private listUnmergedFiles(): string[] {
    const conflicted = this.git(["diff", "--name-only", "--diff-filter=U"], { allowFailure: true });
    if (!conflicted) return [];
    return conflicted.split("\n").map((entry) => entry.trim()).filter(Boolean);
  }

  private autoResolveRuntimeConflicts(conflictedFiles: readonly string[]): boolean {
    if (conflictedFiles.length === 0 || !conflictedFiles.every(isRuntimeConflictPath)) {
      return false;
    }

    for (const file of conflictedFiles) {
      this.git(["checkout", "--ours", "--", file], { allowFailure: true });
      this.git(["rm", "--cached", "--ignore-unmatch", "--", file], { allowFailure: true });
      const absolute = join(this.basePath, file);
      if (existsSync(absolute)) {
        rmSync(absolute, { recursive: true, force: true });
      }
    }
    this.git(["add", "-A"], { allowFailure: true });
    return true;
  }

  ensureSliceBranch(milestoneId: string, sliceId: string): boolean {
    const wtName = detectWorktreeName(this.basePath);
    const branch = getSliceBranchName(milestoneId, sliceId, wtName);
    const current = this.getCurrentBranch();
    const integrationBranch = this.getIntegrationBranch();

    if (current === branch) return false;

    let created = false;

    if (!this.branchExists(branch)) {
      const remotes = this.git(["remote"], { allowFailure: true });
      if (remotes) {
        const remote = this.prefs.remote ?? "origin";
        if (remotes.split("\n").includes(remote)) {
          this.git(["fetch", "--prune", remote], { allowFailure: true });
          const behind = this.git(["rev-list", "--count", "HEAD..@{upstream}"], { allowFailure: true });
          if (behind && Number.parseInt(behind, 10) > 0) {
            console.error(`GitService: local branch is ${behind} commit(s) behind upstream`);
          }
        }
      }

      const base = SLICE_BRANCH_RE.test(current) ? integrationBranch : current;
      this.git(["branch", branch, base]);
      created = true;
    } else {
      const worktreeList = this.git(["worktree", "list", "--porcelain"], { allowFailure: true });
      if (worktreeList.includes(`branch refs/heads/${branch}`)) {
        throw new Error(
          `Branch "${branch}" is already in use by another worktree. Remove that worktree first, or switch it to a different branch.`,
        );
      }
    }

    this.autoCommit("pre-switch", current, [".gsd/"]);
    this.discardRuntimeFilesBeforeCheckout();
    this.git(["checkout", branch]);

    if (!created) {
      const integrationAhead = Number(this.git(["rev-list", "--count", `${branch}..${integrationBranch}`]));
      if (integrationAhead > 0) {
        try {
          this.git(["rebase", integrationBranch]);
        } catch (error) {
          this.git(["rebase", "--abort"], { allowFailure: true });
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`failed to rebase ${branch} onto ${integrationBranch}: ${message}`);
        }
      }
    }

    if (created && this.prefs.push_branches === true) {
      this.push(branch, { setUpstream: true });
    }

    return created;
  }

  switchToMain(): void {
    const integrationBranch = this.getIntegrationBranch();
    const current = this.getCurrentBranch();
    if (current === integrationBranch) return;

    this.autoCommit("pre-switch", current, [".gsd/"]);
    this.discardRuntimeFilesBeforeCheckout();
    this.git(["checkout", integrationBranch]);
  }

  private discardRuntimeFilesBeforeCheckout(): void {
    for (const path of RUNTIME_EXCLUSION_PATHS) {
      this.git(["checkout", "--", path], { allowFailure: true });
      this.git(["clean", "-fdx", "--", path], { allowFailure: true });
    }
  }

  createSnapshot(label: string): void {
    if (this.prefs.snapshots !== true) return;

    const now = new Date();
    const ts = now.getFullYear().toString()
      + String(now.getMonth() + 1).padStart(2, "0")
      + String(now.getDate()).padStart(2, "0")
      + "-"
      + String(now.getHours()).padStart(2, "0")
      + String(now.getMinutes()).padStart(2, "0")
      + String(now.getSeconds()).padStart(2, "0");

    this.git(["update-ref", `refs/gsd/snapshots/${label}/${ts}`, "HEAD"]);
  }

  runPreMergeCheck(): PreMergeCheckResult {
    const pref = this.prefs.pre_merge_check;

    if (pref === false) {
      return { passed: true, skipped: true };
    }

    let command: string | null = null;
    if (typeof pref === "string" && pref !== "auto" && pref.trim() !== "") {
      command = pref.trim();
    }
    if (command === null) {
      command = this.detectTestRunner();
    }
    if (command === null) {
      return { passed: true, command: "none", error: "no test runner detected" };
    }

    try {
      execSync(command, {
        cwd: this.basePath,
        timeout: 300_000,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
      return { passed: true, command };
    } catch (error) {
      const stderr = error instanceof Error && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).slice(0, 2000)
        : String(error).slice(0, 2000);
      return { passed: false, command, error: stderr };
    }
  }

  private detectTestRunner(): string | null {
    const pkgPath = join(this.basePath, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg?.scripts?.test) return "npm test";
        if (pkg?.scripts?.build) return "npm run build";
      } catch {
        // Invalid JSON, ignore.
      }
    }

    if (existsSync(join(this.basePath, "Cargo.toml"))) return "cargo test";

    const makefilePath = join(this.basePath, "Makefile");
    if (existsSync(makefilePath)) {
      try {
        const content = readFileSync(makefilePath, "utf-8");
        if (/^test\s*:/m.test(content)) return "make test";
      } catch {
        // Ignore unreadable file.
      }
    }

    if (existsSync(join(this.basePath, "pyproject.toml"))) return "python -m pytest";

    return null;
  }

  private buildRichCommitMessage(
    commitType: string,
    milestoneId: string,
    sliceId: string,
    sliceTitle: string,
    mainBranch: string,
    branch: string,
  ): string {
    const subject = `${commitType}(${milestoneId}/${sliceId}): ${sliceTitle}`;
    const logOutput = this.git(
      ["log", "--oneline", "--format=%s", `${mainBranch}..${branch}`],
      { allowFailure: true },
    );
    if (!logOutput) return subject;

    const subjects = logOutput.split("\n").filter(Boolean);
    const maxEntries = 20;
    const truncated = subjects.length > maxEntries;
    const displayed = truncated ? subjects.slice(0, maxEntries) : subjects;
    const taskLines = displayed.map((subjectLine) => `- ${subjectLine}`).join("\n");
    const truncationLine = truncated ? `\n- ... and ${subjects.length - maxEntries} more` : "";

    return `${subject}\n\nTasks:\n${taskLines}${truncationLine}\n\nBranch: ${branch}`;
  }

  mergeSliceToMain(milestoneId: string, sliceId: string, sliceTitle: string): MergeSliceResult {
    const mainBranch = this.getIntegrationBranch();
    const current = this.getCurrentBranch();

    if (current !== mainBranch) {
      throw new Error(
        `mergeSliceToMain must be called from the main branch ("${mainBranch}"), but currently on "${current}"`,
      );
    }

    const wtName = detectWorktreeName(this.basePath);
    const branch = getSliceBranchName(milestoneId, sliceId, wtName);
    if (!this.branchExists(branch)) {
      throw new Error(`Slice branch "${branch}" does not exist. Nothing to merge.`);
    }

    const aheadCount = this.git(["rev-list", "--count", `${mainBranch}..${branch}`]);
    if (aheadCount === "0") {
      throw new Error(`Slice branch "${branch}" has no commits ahead of "${mainBranch}". Nothing to merge.`);
    }

    this.createSnapshot(branch);
    this.untrackRuntimeFilesBeforeMerge();

    const commitType = this.prefs.commit_type ?? inferCommitType(sliceTitle);
    const message = this.buildRichCommitMessage(
      commitType,
      milestoneId,
      sliceId,
      sliceTitle,
      mainBranch,
      branch,
    );

    try {
      this.git(["merge", "--squash", branch]);
    } catch (mergeError) {
      const conflictedFiles = this.listUnmergedFiles();
      if (conflictedFiles.length > 0) {
        if (!this.autoResolveRuntimeConflicts(conflictedFiles)) {
          throw new MergeConflictError(conflictedFiles, branch, mainBranch);
        }
      } else {
        this.git(["reset", "--hard", "HEAD"], { allowFailure: true });
        const message = mergeError instanceof Error ? mergeError.message : String(mergeError);
        throw new Error(
          `Squash-merge of "${branch}" into "${mainBranch}" failed. `
          + `Working tree has been reset to a clean state. `
          + `Resolve manually: git checkout ${mainBranch} && git merge --squash ${branch}\n`
          + `Original error: ${message}`,
        );
      }
    }

    const checkResult = this.runPreMergeCheck();
    if (!checkResult.passed && !checkResult.skipped) {
      this.git(["reset", "--hard", "HEAD"]);
      const cmdInfo = checkResult.command ? ` (command: ${checkResult.command})` : "";
      const errInfo = checkResult.error ? `\n${checkResult.error}` : "";
      throw new Error(`Pre-merge check failed${cmdInfo}. Merge aborted.${errInfo}`);
    }

    const staged = this.git(["diff", "--cached", "--stat"], { allowFailure: true });
    if (staged) {
      this.git(["commit", "-F", "-"], { input: message });
    } else {
      this.git(["reset"], { allowFailure: true });
    }
    this.git(["branch", "-D", branch]);

    if (staged && this.prefs.auto_push === true) {
      this.push(mainBranch);
    }

    return {
      branch,
      mergedCommitMessage: `${commitType}(${milestoneId}/${sliceId}): ${sliceTitle}`,
      deletedBranch: true,
    };
  }
}

export function inferCommitType(sliceTitle: string): string {
  const lower = sliceTitle.toLowerCase();

  for (const [keywords, commitType] of COMMIT_TYPE_RULES) {
    for (const keyword of keywords) {
      if (keyword.includes(" ")) {
        if (lower.includes(keyword)) return commitType;
      } else {
        const re = new RegExp(`\\b${keyword}\\b`, "i");
        if (re.test(lower)) return commitType;
      }
    }
  }

  return "feat";
}
