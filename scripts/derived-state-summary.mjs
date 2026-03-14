import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gsdRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { deriveState } = await import(new URL("../src/resources/extensions/gsd/state.ts", import.meta.url));
const { indexWorkspace } = await import(new URL("../src/resources/extensions/gsd/workspace-index.ts", import.meta.url));
const { loadFile, parseRoadmap, extractSection } = await import(new URL("../src/resources/extensions/gsd/files.ts", import.meta.url));
const { resolveMilestoneFile } = await import(new URL("../src/resources/extensions/gsd/paths.ts", import.meta.url));
const { classifyTaskComplexity } = await import(new URL("../src/resources/extensions/gsd/task-complexity.ts", import.meta.url));

function readAutoLock(basePath) {
  const lockPath = join(basePath, ".gsd", "auto.lock");
  if (!existsSync(lockPath)) return null;

  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function formatActiveRef(ref) {
  return ref ? `${ref.id} — ${ref.title}` : "none";
}

function formatOverallProgress(overall) {
  if (!overall) return null;
  return `${overall.tasks.done}/${overall.tasks.total} tasks · ${overall.slices.done}/${overall.slices.total} slices · ${overall.milestones.done}/${overall.milestones.total} milestones`;
}

async function buildSliceRiskMap(basePath, milestones) {
  const riskBySlice = new Map();
  for (const milestone of milestones) {
    if (!milestone.roadmapPath) continue;
    const roadmapFile = resolveMilestoneFile(basePath, milestone.id, "ROADMAP");
    const roadmapContent = roadmapFile ? await loadFile(roadmapFile) : null;
    if (!roadmapContent) continue;
    const roadmap = parseRoadmap(roadmapContent);
    for (const slice of roadmap.slices) {
      riskBySlice.set(`${milestone.id}/${slice.id}`, slice.risk);
    }
  }
  return riskBySlice;
}

async function main() {
  const basePath = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  const state = await deriveState(basePath);
  const workspace = await indexWorkspace(basePath);
  const lock = readAutoLock(basePath);
  const riskBySlice = await buildSliceRiskMap(basePath, workspace.milestones);
  const pendingSlices = [];
  const pendingTasks = [];

  for (const milestone of workspace.milestones) {
    if (!milestone.roadmapPath) continue;
    for (const slice of milestone.slices) {
      if (slice.done) continue;
      const sliceScope = `${milestone.id}/${slice.id}`;
      const sliceRisk = riskBySlice.get(sliceScope) ?? "unknown";
      const remainingTasks = slice.tasks.filter((task) => !task.done);
      pendingSlices.push({
        scope: sliceScope,
        title: slice.title,
        risk: sliceRisk,
        remainingTaskCount: remainingTasks.length,
      });

      for (const task of remainingTasks) {
        const taskPlanContent = task.planPath ? await loadFile(task.planPath) : null;
        pendingTasks.push({
          scope: `${sliceScope}/${task.id}`,
          title: task.title,
          complexity: classifyTaskComplexity({
            taskTitle: task.title,
            taskPlanContent,
            sliceRisk,
          }),
        });
      }
    }
  }

  const lines = [
    `derived-active-milestone: ${formatActiveRef(state.activeMilestone)}`,
    `derived-active-slice: ${formatActiveRef(state.activeSlice)}`,
    `derived-active-task: ${formatActiveRef(state.activeTask)}`,
    `derived-phase: ${state.phase}`,
    `derived-next-action: ${state.nextAction}`,
  ];
  const overallProgress = formatOverallProgress(state.progress?.overall);
  if (overallProgress) {
    lines.push(`derived-overall-progress: ${overallProgress}`);
  }

  if (state.activeBranch) {
    lines.push(`derived-branch: ${state.activeBranch}`);
  }

  if (lock?.unitId) {
    lines.push(`current-dispatch: ${lock.unitType ?? "unknown"} ${lock.unitId}`);
  } else {
    lines.push("current-dispatch: none");
  }

  lines.push(`pending-slices-total: ${pendingSlices.length}`);
  for (const slice of pendingSlices) {
    lines.push(`pending-slice: ${slice.scope} — ${slice.title} [risk:${slice.risk}] [pending-tasks:${slice.remainingTaskCount}]`);
  }

  lines.push(`pending-tasks-total: ${pendingTasks.length}`);
  for (const task of pendingTasks) {
    lines.push(`pending-task: ${task.scope} — ${task.title} [complexity:${task.complexity}]`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`derived-state-summary failed in ${gsdRoot}: ${message}\n`);
  process.exit(1);
});
