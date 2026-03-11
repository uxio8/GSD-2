import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gsdRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { deriveState } = await import(new URL("../src/resources/extensions/gsd/state.ts", import.meta.url));

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

async function main() {
  const basePath = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
  const state = await deriveState(basePath);
  const lock = readAutoLock(basePath);

  const lines = [
    `derived-active-milestone: ${formatActiveRef(state.activeMilestone)}`,
    `derived-active-slice: ${formatActiveRef(state.activeSlice)}`,
    `derived-active-task: ${formatActiveRef(state.activeTask)}`,
    `derived-phase: ${state.phase}`,
    `derived-next-action: ${state.nextAction}`,
  ];

  if (state.activeBranch) {
    lines.push(`derived-branch: ${state.activeBranch}`);
  }

  if (lock?.unitId) {
    lines.push(`current-dispatch: ${lock.unitType ?? "unknown"} ${lock.unitId}`);
  } else {
    lines.push("current-dispatch: none");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`derived-state-summary failed in ${gsdRoot}: ${message}\n`);
  process.exit(1);
});
