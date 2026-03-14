import { randomInt } from "node:crypto";

export const MILESTONE_ID_PATTERN = "M\\d{3}(?:-[a-z0-9]{6})?";
export const MILESTONE_ID_RE = new RegExp(`^${MILESTONE_ID_PATTERN}$`);
const MILESTONE_ID_PREFIX_RE = new RegExp(`^(${MILESTONE_ID_PATTERN})(?:$|-)`);
const MILESTONE_TITLE_PREFIX_RE = new RegExp(`^${MILESTONE_ID_PATTERN}[^:]*:\\s*`);

export function extractMilestoneIdPrefix(value: string): string | null {
  const match = value.match(MILESTONE_ID_PREFIX_RE);
  return match?.[1] ?? null;
}

export function normalizeMilestoneId(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^m(\d{3})(?:-([a-z0-9]{6}))?$/i);
  if (!match) return trimmed;
  return `M${match[1]}${match[2] ? `-${match[2].toLowerCase()}` : ""}`;
}

export function extractMilestoneSeq(id: string): number {
  const match = normalizeMilestoneId(id).match(/^M(\d{3})(?:-[a-z0-9]{6})?$/);
  return match ? Number(match[1]) : 0;
}

export function parseMilestoneId(id: string): { prefix?: string; num: number } {
  const match = normalizeMilestoneId(id).match(/^M(\d{3})(?:-([a-z0-9]{6}))?$/);
  if (!match) return { num: 0 };
  return {
    ...(match[2] ? { prefix: match[2] } : {}),
    num: Number(match[1]),
  };
}

export function milestoneIdSort(a: string, b: string): number {
  const seqDelta = extractMilestoneSeq(a) - extractMilestoneSeq(b);
  if (seqDelta !== 0) return seqDelta;
  return normalizeMilestoneId(a).localeCompare(normalizeMilestoneId(b));
}

export function generateMilestonePrefix(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let prefix = "";
  for (let i = 0; i < 6; i += 1) {
    prefix += chars[randomInt(chars.length)];
  }
  return prefix;
}

export function maxMilestoneNum(milestoneIds: string[]): number {
  return milestoneIds.reduce((max, id) => {
    const seq = extractMilestoneSeq(id);
    return seq > max ? seq : max;
  }, 0);
}

export function nextMilestoneId(milestoneIds: string[], uniqueEnabled = false): string {
  const seq = String(maxMilestoneNum(milestoneIds) + 1).padStart(3, "0");
  return uniqueEnabled ? `M${seq}-${generateMilestonePrefix()}` : `M${seq}`;
}

export function stripMilestoneTitlePrefix(title: string): string {
  return title.replace(MILESTONE_TITLE_PREFIX_RE, "");
}
