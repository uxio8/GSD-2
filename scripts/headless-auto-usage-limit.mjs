import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const defaultUsageLimitWaitMs = 30 * 60 * 1000;

export function getUsageLimitMarkerPath(projectPath) {
  return join(projectPath, ".gsd", "usage-limit.json");
}

export function readUsageLimitMarker(projectPath) {
  const markerPath = getUsageLimitMarkerPath(projectPath);
  if (!existsSync(markerPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.message !== "string" || typeof parsed.retryAt !== "string") return null;
    return {
      detectedAt: typeof parsed.detectedAt === "string" ? parsed.detectedAt : null,
      message: parsed.message,
      retryAt: parsed.retryAt,
    };
  } catch {
    return null;
  }
}

export function writeUsageLimitMarker(projectPath, signal, now = new Date()) {
  const retryAt = signal.retryAt instanceof Date
    ? signal.retryAt
    : new Date(now.getTime() + defaultUsageLimitWaitMs);
  const marker = {
    detectedAt: now.toISOString(),
    message: signal.message,
    retryAt: retryAt.toISOString(),
  };
  mkdirSync(join(projectPath, ".gsd"), { recursive: true });
  writeFileSync(getUsageLimitMarkerPath(projectPath), JSON.stringify(marker, null, 2), "utf8");
  return marker;
}

export function clearUsageLimitMarker(projectPath) {
  const markerPath = getUsageLimitMarkerPath(projectPath);
  try {
    unlinkSync(markerPath);
  } catch {
  }
}

export function resolveUsageLimitWait(projectPath, now = new Date()) {
  const marker = readUsageLimitMarker(projectPath);
  if (!marker) return null;

  const retryAtMs = Date.parse(marker.retryAt);
  if (!Number.isFinite(retryAtMs)) return null;

  return {
    marker,
    retryAt: new Date(retryAtMs),
    remainingMs: retryAtMs - now.getTime(),
  };
}
