/**
 * Line-boundary-aware output truncation (native Rust).
 *
 * Truncates tool output at line boundaries, counting by UTF-8 bytes.
 * Three modes: head (keep end), tail (keep start), both (keep start+end).
 */

import { hasNativeBindings, native } from "../native.js";

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalLines: number;
  keptLines: number;
}

export interface TruncateOutputResult {
  text: string;
  truncated: boolean;
  message?: string | null;
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const parts = text.split("\n");
  if (text.endsWith("\n")) {
    parts.pop();
    return parts.map((line) => `${line}\n`);
  }
  const tail = parts.pop();
  return [...parts.map((line) => `${line}\n`), ...(tail !== undefined ? [tail] : [])];
}

function keepFromStart(text: string, maxBytes: number): TruncateResult {
  const lines = splitLines(text);
  const originalLines = lines.length;

  let keptLines = 0;
  let bytes = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + lineBytes > maxBytes) break;
    kept.push(line);
    keptLines += 1;
    bytes += lineBytes;
  }

  return {
    text: kept.join(""),
    truncated: keptLines !== originalLines,
    originalLines,
    keptLines,
  };
}

function keepFromEnd(text: string, maxBytes: number): TruncateResult {
  const lines = splitLines(text);
  const originalLines = lines.length;

  let keptLines = 0;
  let bytes = 0;
  const kept: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (bytes + lineBytes > maxBytes) break;
    kept.unshift(line);
    keptLines += 1;
    bytes += lineBytes;
  }

  return {
    text: kept.join(""),
    truncated: keptLines !== originalLines,
    originalLines,
    keptLines,
  };
}

/**
 * Keep the first `maxBytes` worth of complete lines.
 */
export function truncateTail(text: string, maxBytes: number): TruncateResult {
  if (!hasNativeBindings()) {
    return keepFromStart(text, maxBytes);
  }

  return (native as Record<string, Function>).truncateTail(text, maxBytes) as TruncateResult;
}

/**
 * Keep the last `maxBytes` worth of complete lines.
 */
export function truncateHead(text: string, maxBytes: number): TruncateResult {
  if (!hasNativeBindings()) {
    return keepFromEnd(text, maxBytes);
  }

  return (native as Record<string, Function>).truncateHead(text, maxBytes) as TruncateResult;
}

/**
 * Main entry point: truncate tool output with head/tail/both modes.
 */
export function truncateOutput(
  text: string,
  maxBytes: number,
  mode?: string,
): TruncateOutputResult {
  if (!hasNativeBindings()) {
    const selectedMode = mode ?? "tail";
    if (selectedMode === "head") {
      const result = truncateHead(text, maxBytes);
      return {
        text: result.text,
        truncated: result.truncated,
        message: result.truncated ? `Showing the end of output (${result.keptLines}/${result.originalLines} lines).` : null,
      };
    }

    if (selectedMode === "both") {
      const headBytes = Math.max(1, Math.floor(maxBytes / 2));
      const tailBytes = Math.max(1, maxBytes - headBytes);
      const start = keepFromStart(text, headBytes);
      const end = keepFromEnd(text, tailBytes);
      const truncated = start.truncated || end.truncated;
      return {
        text: truncated ? `${start.text}... [truncated] ...\n${end.text}` : text,
        truncated,
        message: truncated ? `Showing the start and end of output (${start.keptLines + end.keptLines}/${start.originalLines} lines).` : null,
      };
    }

    const result = truncateTail(text, maxBytes);
    return {
      text: result.text,
      truncated: result.truncated,
      message: result.truncated ? `Showing the start of output (${result.keptLines}/${result.originalLines} lines).` : null,
    };
  }

  const result = (native as Record<string, Function>).truncateOutput(
    text,
    maxBytes,
    mode,
  ) as TruncateOutputResult;

  return {
    ...result,
    message: result.message ?? null,
  };
}
