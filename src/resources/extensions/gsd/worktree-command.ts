/**
 * GSD Worktree Command — /worktree
 *
 * Create, list, merge, and remove git worktrees under .gsd/worktrees/.
 *
 * Usage:
 *   /worktree <name>        — create a new worktree
 *   /worktree list          — list existing worktrees
 *   /worktree merge <branch> [target] — start LLM-guided merge (default target: main)
 *   /worktree remove <name> — remove a worktree and its branch
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { loadPrompt } from "./prompt-loader.js";
import { autoCommitCurrentBranch } from "./worktree.js";
import { showConfirm } from "../shared/confirm-ui.js";
import { gsdRoot, milestonesDir } from "./paths.js";
import {
  createWorktree,
  listWorktrees,
  removeWorktree,
  diffWorktreeAll,
  diffWorktreeNumstat,
  diffWorktreeGSD,
  getMainBranch,
  getWorktreeGSDDiff,
  getWorktreeCodeDiff,
  getWorktreeLog,
  worktreeBranchName,
  worktreePath,
} from "./worktree-manager.js";
import type { FileLineStat } from "./worktree-manager.js";
import { existsSync, realpathSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Tracks the original project root so we can switch back.
 * Set when we first chdir into a worktree, cleared on return.
 */
let originalCwd: string | null = null;

/** Get the original project root if currently in a worktree, or null. */
export function getWorktreeOriginalCwd(): string | null {
  return originalCwd;
}

/**
 * Resolve the git HEAD file path for a given directory.
 * Handles both normal repos (.git is a directory) and worktrees (.git is a file).
 */
function resolveGitHeadPath(dir: string): string | null {
  const gitPath = join(dir, ".git");
  if (!existsSync(gitPath)) return null;

  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (content.startsWith("gitdir: ")) {
      // Worktree — .git is a file pointing to the real gitdir
      const gitDir = resolve(dir, content.slice(8));
      const headPath = join(gitDir, "HEAD");
      return existsSync(headPath) ? headPath : null;
    }
    // Normal repo — .git is a directory
    const headPath = join(dir, ".git", "HEAD");
    return existsSync(headPath) ? headPath : null;
  } catch {
    return null;
  }
}

/**
 * Nudge pi's FooterDataProvider to re-read the git branch.
 *
 * The footer caches the branch and watches a single .git dir for changes.
 * After process.chdir() into a worktree (or back), the watcher is stale —
 * it's still watching the old git dir. We touch HEAD in both the old and
 * new git dirs to ensure the watcher fires regardless of which one it's
 * monitoring. This clears cachedBranch; the next getGitBranch() call uses
 * the new process.cwd() and picks up the correct branch.
 */
function nudgeGitBranchCache(previousCwd: string): void {
  const now = new Date();
  for (const dir of [previousCwd, process.cwd()]) {
    try {
      const headPath = resolveGitHeadPath(dir);
      if (headPath) utimesSync(headPath, now, now);
    } catch {
      // Best-effort — branch display may be stale
    }
  }
}

/** Get the name of the active worktree, or null if not in one. */
export function getActiveWorktreeName(): string | null {
  if (!originalCwd) return null;
  const cwd = process.cwd();
  const wtDir = join(originalCwd, ".gsd", "worktrees");
  if (!cwd.startsWith(wtDir)) return null;
  const rel = cwd.slice(wtDir.length + 1);
  const name = rel.split("/")[0] ?? rel.split("\\")[0];
  return name || null;
}

export function activateWorktree(
  basePath: string,
  name: string,
  opts: { createIfMissing?: boolean; failIfExists?: boolean } = {},
): { path: string; branch: string; commitMsg: string | null } {
  const { createIfMissing = false, failIfExists = false } = opts;
  const mainBase = originalCwd ?? basePath;
  const existing = listWorktrees(mainBase).find((wt) => wt.name === name);

  let path: string;
  let branch: string;

  if (existing) {
    if (failIfExists) {
      throw new Error(`Worktree "${name}" already exists. Use /worktree switch ${name} to reuse it.`);
    }
    if (!existing.exists || !existsSync(existing.path)) {
      throw new Error(`Worktree "${name}" not found. Run /worktree list to see available worktrees.`);
    }
    path = existing.path;
    branch = existing.branch;
  } else {
    if (!createIfMissing) {
      throw new Error(`Worktree "${name}" not found. Run /worktree list to see available worktrees.`);
    }
    const createdInfo = createWorktree(mainBase, name);
    path = createdInfo.path;
    branch = createdInfo.branch;
  }

  const commitMsg = autoCommitCurrentBranch(basePath, "worktree-switch", name);

  if (!originalCwd) originalCwd = basePath;

  const prevCwd = process.cwd();
  process.chdir(path);
  nudgeGitBranchCache(prevCwd);

  return { path, branch, commitMsg };
}

// ─── Shared completions and handler (used by both /worktree and /wt) ────────

function worktreeCompletions(prefix: string) {
  const parts = prefix.trim().split(/\s+/);
  const subcommands = ["list", "merge", "remove", "switch", "create", "return"];

  if (parts.length <= 1) {
    const partial = parts[0] ?? "";
    const cmdCompletions = subcommands
      .filter(cmd => cmd.startsWith(partial))
      .map(cmd => ({ value: cmd, label: cmd }));
    try {
      const mainBase = getWorktreeOriginalCwd() ?? process.cwd();
      const existing = listWorktrees(mainBase);
      const nameCompletions = existing
        .filter(wt => wt.name.startsWith(partial))
        .map(wt => ({ value: wt.name, label: wt.name }));
      return [...cmdCompletions, ...nameCompletions];
    } catch {
      return cmdCompletions;
    }
  }

  if ((parts[0] === "merge" || parts[0] === "remove" || parts[0] === "switch" || parts[0] === "create") && parts.length <= 2) {
    const namePrefix = parts[1] ?? "";
    try {
      const mainBase = getWorktreeOriginalCwd() ?? process.cwd();
      const existing = listWorktrees(mainBase);
      const completions = existing
        .filter(wt => wt.name.startsWith(namePrefix))
        .map(wt => ({ value: `${parts[0]} ${wt.name}`, label: wt.name }));
      if (parts[0] === "remove" && "all".startsWith(namePrefix)) {
        completions.push({ value: "remove all", label: "all" });
      }
      return completions;
    } catch {
      return [];
    }
  }

  return [];
}

async function worktreeHandler(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  alias: string,
): Promise<void> {
  const trimmed = (typeof args === "string" ? args : "").trim();
  const basePath = process.cwd();

  if (trimmed === "") {
    ctx.ui.notify(
      [
        "Usage:",
        `  /${alias} <name>        — create and switch into a new worktree`,
        `  /${alias} create <name> — create and switch into a new worktree`,
        `  /${alias} switch <name> — switch into an existing worktree`,
        `  /${alias} return        — switch back to the main project tree`,
        `  /${alias} list          — list all worktrees`,
        `  /${alias} merge [name] [target] — merge worktree into target branch`,
        `  /${alias} remove <name|all> — remove a worktree (or all) and its branch`,
      ].join("\n"),
      "info",
    );
    return;
  }

  if (trimmed === "list") {
    await handleList(basePath, ctx);
    return;
  }

  if (trimmed === "return") {
    await handleReturn(ctx);
    return;
  }

  if (trimmed.startsWith("switch ") || trimmed.startsWith("create ")) {
    const name = trimmed.replace(/^(?:switch|create)\s+/, "").trim();
    if (!name) {
      ctx.ui.notify(`Usage: /${alias} ${trimmed.split(" ")[0]} <name>`, "warning");
      return;
    }
    const mainBase = originalCwd ?? basePath;
    const existing = listWorktrees(mainBase);
    if (existing.some((wt) => wt.name === name)) {
      await handleSwitch(basePath, name, ctx);
    } else {
      await handleCreate(basePath, name, ctx);
    }
    return;
  }

  if (trimmed === "merge" || trimmed.startsWith("merge ")) {
    const mergeArgs = trimmed.replace(/^merge\s*/, "").trim().split(/\s+/).filter(Boolean);
    const mainBase = originalCwd ?? basePath;
    const activeWt = getActiveWorktreeName();

    if (mergeArgs.length === 0) {
      if (!activeWt) {
        ctx.ui.notify(`Usage: /${alias} merge <name> [target]`, "warning");
        return;
      }
      await handleMerge(mainBase, activeWt, ctx, pi, undefined);
      return;
    }

    const name = mergeArgs[0]!;
    const targetBranch = mergeArgs[1];
    const worktrees = listWorktrees(mainBase);
    const isWorktree = worktrees.some((wt) => wt.name === name);

    if (isWorktree) {
      await handleMerge(mainBase, name, ctx, pi, targetBranch);
    } else if (activeWt) {
      await handleMerge(mainBase, activeWt, ctx, pi, name);
    } else {
      ctx.ui.notify(`Worktree "${name}" not found. Run /${alias} list to see available worktrees.`, "warning");
    }
    return;
  }

  if (trimmed === "remove" || trimmed.startsWith("remove ")) {
    const name = trimmed.replace(/^remove\s*/, "").trim();
    const mainBase = originalCwd ?? basePath;
    if (name === "all") {
      await handleRemoveAll(mainBase, ctx);
      return;
    }
    if (!name) {
      ctx.ui.notify(`Usage: /${alias} remove <name|all>`, "warning");
      return;
    }
    await handleRemove(mainBase, name, ctx);
    return;
  }

  const RESERVED = ["list", "return", "switch", "create", "merge", "remove"];
  if (RESERVED.includes(trimmed)) {
    ctx.ui.notify(`Usage: /${alias} ${trimmed}${trimmed === "list" || trimmed === "return" ? "" : " <name>"}`, "warning");
    return;
  }

  const mainBase = originalCwd ?? basePath;
  const nameOnly = trimmed.split(/\s+/)[0]!;
  if (trimmed !== nameOnly) {
    ctx.ui.notify(`Unknown command. Did you mean /${alias} switch ${nameOnly}?`, "warning");
    return;
  }

  const existing = listWorktrees(mainBase);
  if (existing.some(wt => wt.name === nameOnly)) {
    await handleSwitch(basePath, nameOnly, ctx);
  } else {
    await handleCreate(basePath, nameOnly, ctx);
  }
}

export function registerWorktreeCommand(pi: ExtensionAPI): void {
  if (!originalCwd) {
    const cwd = process.cwd();
    const marker = `${sep}.gsd${sep}worktrees${sep}`;
    const markerIdx = cwd.indexOf(marker);
    if (markerIdx !== -1) {
      originalCwd = cwd.slice(0, markerIdx);
    }
  }

  pi.registerCommand("worktree", {
    description: "Git worktrees: /worktree <name> | list | merge | remove",
    getArgumentCompletions: worktreeCompletions,

    async handler(args: string, ctx: ExtensionCommandContext) {
      await worktreeHandler(args, ctx, pi, "worktree");
    },
  });

  // /wt alias — same handler, same completions
  pi.registerCommand("wt", {
    description: "Alias for /worktree",
    getArgumentCompletions: worktreeCompletions,
    async handler(args: string, ctx: ExtensionCommandContext) {
      await worktreeHandler(args, ctx, pi, "wt");
    },
  });
}

// ─── Handlers ──────────────────────────────────────────────────────────────

function hasExistingMilestones(wtPath: string): boolean {
  const mDir = milestonesDir(wtPath);
  if (!existsSync(mDir)) return false;
  try {
    return readdirSync(mDir, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && /^M\d+/.test(entry.name));
  } catch {
    return false;
  }
}

function clearGSDPlans(wtPath: string): void {
  const mDir = milestonesDir(wtPath);
  if (existsSync(mDir)) {
    rmSync(mDir, { recursive: true, force: true });
  }

  const root = gsdRoot(wtPath);
  for (const file of ["PROJECT.md", "DECISIONS.md", "QUEUE.md", "REQUIREMENTS.md"]) {
    const filePath = join(root, file);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }
}

async function handleCreate(
  basePath: string,
  name: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const info = activateWorktree(basePath, name, { createIfMissing: true, failIfExists: true });

    let clearedPlans = false;
    if (hasExistingMilestones(info.path)) {
      const keepExisting = await showConfirm(ctx, {
        title: "Worktree Setup",
        message: [
          `This worktree inherited existing GSD milestones from the main branch.`,
          ``,
          `  Continue — keep milestones and pick up where main left off`,
          `  Start fresh — clear milestones so /gsd auto starts a new project`,
        ].join("\n"),
        confirmLabel: "Continue",
        declineLabel: "Start fresh",
      });
      if (!keepExisting) {
        clearGSDPlans(info.path);
        clearedPlans = true;
      }
    }

    const commitNote = info.commitMsg ? `\n  Auto-committed on previous branch before switching.` : "";
    const freshNote = clearedPlans ? `\n  Cleared milestones so /gsd auto starts fresh in this worktree.` : "";
    ctx.ui.notify(
      [
        `Worktree "${name}" created and activated.`,
        `  Path:   ${info.path}`,
        `  Branch: ${info.branch}`,
        commitNote,
        freshNote,
        `Session is now in the worktree. All commands run here.`,
        `Use /worktree merge ${name} to merge back when done.`,
        `Use /worktree return to switch back to the main tree.`,
      ].filter(Boolean).join("\n"),
      "info",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to create worktree: ${msg}`, "error");
  }
}

async function handleSwitch(
  basePath: string,
  name: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const info = activateWorktree(basePath, name);

    const commitNote = info.commitMsg ? `\n  Auto-committed on previous branch before switching.` : "";
    ctx.ui.notify(
      [
        `Switched to worktree "${name}".`,
        `  Path:   ${info.path}`,
        `  Branch: ${info.branch}`,
        commitNote,
        `Use /worktree return to switch back to the main tree.`,
      ].filter(Boolean).join("\n"),
      "info",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to switch to worktree: ${msg}`, "error");
  }
}

async function handleReturn(ctx: ExtensionCommandContext): Promise<void> {
  if (!originalCwd) {
    ctx.ui.notify("Already in the main project tree.", "info");
    return;
  }

  // Auto-commit dirty files before leaving worktree
  const commitMsg = autoCommitCurrentBranch(process.cwd(), "worktree-return", "worktree");

  const returnTo = originalCwd;
  originalCwd = null;

  const prevCwd = process.cwd();
  process.chdir(returnTo);
  nudgeGitBranchCache(prevCwd);

  const commitNote = commitMsg ? `\n  Auto-committed on worktree branch before returning.` : "";
  ctx.ui.notify(
    [
      `Returned to main project tree.`,
      `  Path: ${returnTo}`,
      commitNote,
    ].filter(Boolean).join("\n"),
    "info",
  );
}

// ANSI helpers for list formatting
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const WHITE = "\x1b[37m";

async function handleList(
  basePath: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const mainBase = originalCwd ?? basePath;
    const worktrees = listWorktrees(mainBase);

    if (worktrees.length === 0) {
      ctx.ui.notify("No GSD worktrees found. Create one with /worktree <name>.", "info");
      return;
    }

    const cwd = process.cwd();
    const lines = [`${BOLD}${WHITE}GSD Worktrees${RESET}`, ""];
    for (const wt of worktrees) {
      const isCurrent = cwd === wt.path
        || (existsSync(cwd) && existsSync(wt.path)
          && realpathSync(cwd) === realpathSync(wt.path));

      const nameColor = isCurrent ? GREEN : CYAN;
      const badge = isCurrent ? `  ${GREEN}● active${RESET}` : !wt.exists ? `  ${YELLOW}✗ missing${RESET}` : "";
      lines.push(`  ${BOLD}${nameColor}${wt.name}${RESET}${badge}`);
      lines.push(`  ${DIM}  branch${RESET}  ${wt.branch}`);
      lines.push(`  ${DIM}  path${RESET}    ${DIM}${wt.path}${RESET}`);
      lines.push("");
    }

    if (originalCwd) {
      lines.push(`${DIM}Main tree: ${originalCwd}${RESET}`);
    }

    ctx.ui.notify(lines.join("\n"), "info");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to list worktrees: ${msg}`, "error");
  }
}

async function handleMerge(
  basePath: string,
  name: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  targetBranch?: string,
): Promise<void> {
  try {
    const branch = worktreeBranchName(name);
    const mainBranch = targetBranch ?? getMainBranch(basePath);

    // Validate the worktree/branch exists
    const worktrees = listWorktrees(basePath);
    const wt = worktrees.find(w => w.name === name);
    if (!wt) {
      ctx.ui.notify(`Worktree "${name}" not found. Run /worktree list to see available worktrees.`, "warning");
      return;
    }

    const diffSummary = diffWorktreeAll(basePath, name);
    const numstat = diffWorktreeNumstat(basePath, name);
    const gsdDiff = getWorktreeGSDDiff(basePath, name);
    const codeDiff = getWorktreeCodeDiff(basePath, name);
    const commitLog = getWorktreeLog(basePath, name);

    const totalChanges = diffSummary.added.length + diffSummary.modified.length + diffSummary.removed.length;
    if (totalChanges === 0 && !commitLog.trim()) {
      ctx.ui.notify(`Worktree "${name}" has no changes to merge.`, "info");
      return;
    }

    const statMap = new Map<string, FileLineStat>();
    for (const stat of numstat) statMap.set(stat.file, stat);

    let totalAdded = 0;
    let totalRemoved = 0;
    for (const stat of numstat) {
      totalAdded += stat.added;
      totalRemoved += stat.removed;
    }

    const isGsd = (file: string) => file.startsWith(".gsd/");
    const codeChanges = diffSummary.added.filter((f) => !isGsd(f)).length
      + diffSummary.modified.filter((f) => !isGsd(f)).length
      + diffSummary.removed.filter((f) => !isGsd(f)).length;
    const gsdChanges = diffSummary.added.filter(isGsd).length
      + diffSummary.modified.filter(isGsd).length
      + diffSummary.removed.filter(isGsd).length;

    const formatFileLine = (prefix: string, file: string): string => {
      const stat = statMap.get(file);
      const detail = stat ? ` +${stat.added} -${stat.removed}` : "";
      return `    ${prefix} ${file}${detail}`;
    };

    const previewLines = [
      `Merge worktree "${name}" → ${mainBranch}`,
      "",
      `  ${totalChanges} file${totalChanges === 1 ? "" : "s"} changed, +${totalAdded} -${totalRemoved} lines (${codeChanges} code, ${gsdChanges} GSD)`,
    ];

    const appendFiles = (label: string, files: string[], prefix: string, limit = 10) => {
      if (files.length === 0) return;
      previewLines.push("", `  ${label}:`);
      for (const file of files.slice(0, limit)) previewLines.push(formatFileLine(prefix, file));
      if (files.length > limit) previewLines.push(`    … and ${files.length - limit} more`);
    };

    appendFiles("Added", diffSummary.added, "+");
    appendFiles("Modified", diffSummary.modified, "~");
    appendFiles("Removed", diffSummary.removed, "-");

    const confirmed = await showConfirm(ctx, {
      title: "Worktree Merge",
      message: previewLines.join("\n"),
      confirmLabel: "Merge",
      declineLabel: "Cancel",
    });
    if (!confirmed) {
      ctx.ui.notify("Merge cancelled.", "info");
      return;
    }

    if (originalCwd) {
      const prevCwd = process.cwd();
      process.chdir(basePath);
      nudgeGitBranchCache(prevCwd);
      originalCwd = null;
    }

    const formatFiles = (files: string[]) =>
      files.length > 0 ? files.map(f => `- \`${f}\``).join("\n") : "_(none)_";

    const wtPath = worktreePath(basePath, name);
    const prompt = loadPrompt("worktree-merge", {
      worktreeName: name,
      worktreeBranch: branch,
      mainBranch,
      mainTreePath: basePath,
      worktreePath: wtPath,
      commitLog: commitLog || "(no commits)",
      addedFiles: formatFiles(diffSummary.added),
      modifiedFiles: formatFiles(diffSummary.modified),
      removedFiles: formatFiles(diffSummary.removed),
      gsdDiff: gsdDiff || "(no GSD artifact changes)",
      codeDiff: codeDiff || "(no code changes)",
    });

    // Dispatch to the LLM
    pi.sendMessage(
      {
        customType: "gsd-worktree-merge",
        content: prompt,
        display: false,
      },
      { triggerTurn: true },
    );

    ctx.ui.notify(
      `Merge helper started for worktree "${name}" (${codeChanges} code + ${gsdChanges} GSD change${totalChanges === 1 ? "" : "s"}).`,
      "info",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to start merge: ${msg}`, "error");
  }
}

async function handleRemove(
  basePath: string,
  name: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const mainBase = originalCwd ?? basePath;
    const worktrees = listWorktrees(mainBase);
    const wt = worktrees.find((entry) => entry.name === name);
    if (!wt) {
      ctx.ui.notify(`Worktree "${name}" not found. Run /worktree list to see available worktrees.`, "warning");
      return;
    }

    const confirmed = await showConfirm(ctx, {
      title: "Remove Worktree",
      message: `Remove worktree "${name}" and delete branch ${wt.branch}?`,
      confirmLabel: "Remove",
      declineLabel: "Cancel",
    });
    if (!confirmed) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }

    const prevCwd = process.cwd();
    removeWorktree(mainBase, name, { deleteBranch: true });

    // If we were in that worktree, removeWorktree chdir'd us out — clear tracking
    if (originalCwd && process.cwd() !== prevCwd) {
      nudgeGitBranchCache(prevCwd);
      originalCwd = null;
    }

    ctx.ui.notify(`Worktree "${name}" removed (branch deleted).`, "info");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to remove worktree: ${msg}`, "error");
  }
}

async function handleRemoveAll(
  basePath: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  try {
    const mainBase = originalCwd ?? basePath;
    const worktrees = listWorktrees(mainBase);
    if (worktrees.length === 0) {
      ctx.ui.notify("No worktrees to remove.", "info");
      return;
    }

    const confirmed = await showConfirm(ctx, {
      title: "Remove All Worktrees",
      message: `Remove ${worktrees.length} worktree${worktrees.length === 1 ? "" : "s"} and delete their branches?\n\n${worktrees.map((wt) => `  • ${wt.name}`).join("\n")}`,
      confirmLabel: "Remove all",
      declineLabel: "Cancel",
    });
    if (!confirmed) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }

    const prevCwd = process.cwd();
    const removed: string[] = [];
    const failed: string[] = [];

    for (const wt of worktrees) {
      try {
        removeWorktree(mainBase, wt.name, { deleteBranch: true });
        removed.push(wt.name);
      } catch {
        failed.push(wt.name);
      }
    }

    if (originalCwd && process.cwd() !== prevCwd) {
      nudgeGitBranchCache(prevCwd);
      originalCwd = null;
    }

    const lines: string[] = [];
    if (removed.length > 0) lines.push(`Removed: ${removed.join(", ")}`);
    if (failed.length > 0) lines.push(`Failed: ${failed.join(", ")}`);
    ctx.ui.notify(lines.join("\n"), failed.length > 0 ? "warning" : "info");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to remove worktrees: ${msg}`, "error");
  }
}
