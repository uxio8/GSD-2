/**
 * GSD Slice Branch Management — GitService facade plus recovery helpers.
 *
 * Git mutations are centralized in GitServiceImpl while branch parsing and
 * pending-merge recovery stay here so existing auto/worktree flows keep their
 * current behavior.
 */

import { sep } from "node:path";

import { parseRoadmap } from "./files.ts";
import { GitServiceImpl, runGit } from "./git-service.ts";
import { loadEffectiveGSDPreferences } from "./preferences.ts";

export interface MergeSliceResult {
  branch: string;
  targetBranch: string;
  mergedCommitMessage: string;
  deletedBranch: boolean;
}

export interface PendingSliceMerge {
  branch: string;
  targetBranch: string;
  milestoneId: string;
  sliceId: string;
  sliceTitle: string;
}

let cachedService: GitServiceImpl | null = null;
let cachedBasePath: string | null = null;

function getService(basePath: string): GitServiceImpl {
  if (cachedService === null || cachedBasePath !== basePath) {
    const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
    cachedService = new GitServiceImpl(basePath, gitPrefs);
    cachedBasePath = basePath;
  }
  return cachedService;
}

export function detectWorktreeName(basePath: string): string | null {
  const marker = `${sep}.gsd${sep}worktrees${sep}`;
  const idx = basePath.indexOf(marker);
  if (idx === -1) return null;
  const afterMarker = basePath.slice(idx + marker.length);
  const name = afterMarker.split(sep)[0] ?? afterMarker.split("/")[0];
  return name || null;
}

export function getSliceBranchName(milestoneId: string, sliceId: string, worktreeName?: string | null): string {
  if (worktreeName) {
    return `gsd/${worktreeName}/${milestoneId}/${sliceId}`;
  }
  return `gsd/${milestoneId}/${sliceId}`;
}

export const SLICE_BRANCH_RE = /^gsd\/(?:([a-zA-Z0-9_-]+)\/)?(M\d+)\/(S\d+)$/;

export function parseSliceBranch(branchName: string): {
  worktreeName: string | null;
  milestoneId: string;
  sliceId: string;
} | null {
  const match = branchName.match(SLICE_BRANCH_RE);
  if (!match) return null;
  return {
    worktreeName: match[1] ?? null,
    milestoneId: match[2]!,
    sliceId: match[3]!,
  };
}

export function getMainBranch(basePath: string): string {
  return getService(basePath).getMainBranch();
}

export function getIntegrationBranch(basePath: string): string {
  return getService(basePath).getIntegrationBranch();
}

export function getCurrentBranch(basePath: string): string {
  return getService(basePath).getCurrentBranch();
}

export function ensureSliceBranch(basePath: string, milestoneId: string, sliceId: string): boolean {
  return getService(basePath).ensureSliceBranch(milestoneId, sliceId);
}

export function autoCommitCurrentBranch(basePath: string, unitType: string, unitId: string): string | null {
  return getService(basePath).autoCommit(unitType, unitId);
}

export function switchToMain(basePath: string): void {
  getService(basePath).switchToMain();
}

export function mergeSliceToMain(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  sliceTitle: string,
): MergeSliceResult {
  const targetBranch = getIntegrationBranch(basePath);
  const result = getService(basePath).mergeSliceToMain(milestoneId, sliceId, sliceTitle);
  return {
    ...result,
    targetBranch,
  };
}

function isAncestorBranch(basePath: string, branch: string, targetBranch: string): boolean {
  try {
    runGit(basePath, ["merge-base", "--is-ancestor", branch, targetBranch]);
    return true;
  } catch {
    return false;
  }
}

function readBranchFile(basePath: string, branch: string, filePath: string): string | null {
  const content = runGit(basePath, ["show", `${branch}:${filePath}`], { allowFailure: true });
  return content || null;
}

export function findPendingCompletedSliceMerge(
  basePath: string,
  milestoneId?: string,
): PendingSliceMerge | null {
  const targetBranch = getIntegrationBranch(basePath);
  const branches = runGit(basePath, ["show-ref", "--heads"], { allowFailure: true })
    .split("\n")
    .map((line) => {
      const ref = line.trim().split(" ")[1];
      return ref?.startsWith("refs/heads/gsd/") ? ref.replace(/^refs\/heads\//, "") : "";
    })
    .filter(Boolean)
    .sort();

  for (const branch of branches) {
    const parsed = parseSliceBranch(branch);
    if (!parsed) continue;

    const { milestoneId: mid, sliceId: sid } = parsed;
    if (milestoneId && mid !== milestoneId) continue;
    if (isAncestorBranch(basePath, branch, targetBranch)) continue;

    const roadmapPath = `.gsd/milestones/${mid}/${mid}-ROADMAP.md`;
    const summaryPath = `.gsd/milestones/${mid}/slices/${sid}/${sid}-SUMMARY.md`;

    const roadmapContent = readBranchFile(basePath, branch, roadmapPath);
    const summaryContent = readBranchFile(basePath, branch, summaryPath);
    if (!roadmapContent || !summaryContent) continue;

    try {
      const roadmap = parseRoadmap(roadmapContent);
      const sliceEntry = roadmap.slices.find((slice) => slice.id === sid);
      if (!sliceEntry?.done) continue;

      return {
        branch,
        targetBranch,
        milestoneId: mid,
        sliceId: sid,
        sliceTitle: sliceEntry.title,
      };
    } catch {
      continue;
    }
  }

  return null;
}

export function isOnSliceBranch(basePath: string): boolean {
  return getService(basePath).isOnSliceBranch();
}

export function getActiveSliceBranch(basePath: string): string | null {
  return getService(basePath).getActiveSliceBranch();
}
