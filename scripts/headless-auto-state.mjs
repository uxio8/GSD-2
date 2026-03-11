export function parseStateSnapshot(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;

  const getField = (label) => raw.match(new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, "m"))?.[1]?.trim() ?? null;

  return {
    activeMilestone: getField("Active Milestone"),
    activeSlice: getField("Active Slice"),
    activeTask: getField("Active Task"),
    phase: getField("Phase"),
    nextAction: getField("Next Action"),
  };
}

export function isTerminalState(state) {
  if (!state) return false;
  if (state.phase === "blocked") return true;
  if (state.phase === "complete") return true;
  return state.nextAction === "All milestones complete.";
}
