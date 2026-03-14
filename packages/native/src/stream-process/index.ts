/**
 * Bash stream processor — single-pass UTF-8 decode + ANSI strip + binary sanitization.
 *
 * Handles chunk boundaries for incomplete UTF-8 and ANSI escape sequences.
 */

import { hasNativeBindings, native } from "../native.js";

export interface StreamState {
  utf8Pending: number[];
  ansiPending: number[];
}

export interface StreamChunkResult {
  text: string;
  state: StreamState;
}

const ANSI_RE =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?(?:\u0007|\u001B\\))|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

function splitUtf8Boundary(buffer: Buffer): { complete: Buffer; pending: number[] } {
  if (buffer.length === 0) {
    return { complete: buffer, pending: [] };
  }

  let leadIndex = buffer.length - 1;
  while (leadIndex >= 0 && (buffer[leadIndex] & 0xc0) === 0x80) {
    leadIndex--;
  }

  if (leadIndex < 0) {
    return { complete: Buffer.alloc(0), pending: Array.from(buffer) };
  }

  const lead = buffer[leadIndex];
  let expected = 1;
  if ((lead & 0x80) === 0x00) expected = 1;
  else if ((lead & 0xe0) === 0xc0) expected = 2;
  else if ((lead & 0xf0) === 0xe0) expected = 3;
  else if ((lead & 0xf8) === 0xf0) expected = 4;

  const available = buffer.length - leadIndex;
  if (available < expected) {
    return {
      complete: buffer.subarray(0, leadIndex),
      pending: Array.from(buffer.subarray(leadIndex)),
    };
  }

  return { complete: buffer, pending: [] };
}

function extractAnsiPending(text: string): { safe: string; pending: string } {
  const escIndex = Math.max(text.lastIndexOf("\u001b"), text.lastIndexOf("\u009b"));
  if (escIndex === -1) {
    return { safe: text, pending: "" };
  }

  const tail = text.slice(escIndex);
  const hasCompleteOsc = tail.startsWith("\u001b]") && (tail.includes("\u0007") || tail.includes("\u001b\\"));
  const hasFinalByte = /[\u0040-\u007e]$/.test(tail);
  if (hasCompleteOsc || hasFinalByte) {
    return { safe: text, pending: "" };
  }

  return {
    safe: text.slice(0, escIndex),
    pending: tail,
  };
}

function stripAnsiFallback(text: string): string {
  return text.replace(ANSI_RE, "");
}

function stripLoneSurrogates(text: string): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += text[index] + text[index + 1];
        index += 1;
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      continue;
    }

    result += text[index];
  }
  return result;
}

function sanitizeBinaryFallback(text: string): string {
  return stripLoneSurrogates(
    text
      .replace(/\r/g, "")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
      .replace(/[\ufff9-\ufffb]/g, ""),
  );
}

/**
 * Process a raw bash output chunk in a single pass.
 *
 * Decodes UTF-8 (handling incomplete multibyte sequences at boundaries),
 * strips ANSI escape sequences, removes control characters (except tab and
 * newline), removes carriage returns, and filters Unicode format characters.
 *
 * Pass the returned `state` to the next call to handle sequences split
 * across chunk boundaries.
 */
export function processStreamChunk(
  chunk: Buffer,
  state?: StreamState,
): StreamChunkResult {
  if (!hasNativeBindings()) {
    const utf8Prefix = state?.utf8Pending?.length ? Buffer.from(state.utf8Pending) : Buffer.alloc(0);
    const combined = utf8Prefix.length > 0 ? Buffer.concat([utf8Prefix, chunk]) : chunk;
    const { complete, pending } = splitUtf8Boundary(combined);
    const text = complete.toString("utf8");
    const ansiPrefix = state?.ansiPending?.length
      ? Buffer.from(state.ansiPending).toString("utf8")
      : "";
    const { safe, pending: ansiPending } = extractAnsiPending(ansiPrefix + text);
    return {
      text: sanitizeBinaryFallback(stripAnsiFallback(safe)),
      state: {
        utf8Pending: pending,
        ansiPending: Array.from(Buffer.from(ansiPending, "utf8")),
      },
    };
  }

  // Convert StreamState arrays to the format napi expects (Vec<u8>)
  const napiState = state
    ? {
        utf8Pending: Buffer.from(state.utf8Pending),
        ansiPending: Buffer.from(state.ansiPending),
      }
    : undefined;

  const result = (native as Record<string, Function>).processStreamChunk(
    chunk,
    napiState,
  ) as {
    text: string;
    state: { utf8Pending: Buffer; ansiPending: Buffer };
  };

  return {
    text: result.text,
    state: {
      utf8Pending: Array.from(result.state.utf8Pending),
      ansiPending: Array.from(result.state.ansiPending),
    },
  };
}

/**
 * Strip ANSI escape sequences from a string.
 */
export function stripAnsiNative(text: string): string {
  if (!hasNativeBindings()) {
    return stripAnsiFallback(text);
  }

  return (native as Record<string, Function>).stripAnsiNative(text) as string;
}

/**
 * Remove binary garbage and control characters from a string.
 *
 * Keeps tab and newline. Removes carriage return, all other control
 * characters, Unicode format characters (U+FFF9-U+FFFB), and lone surrogates.
 */
export function sanitizeBinaryOutputNative(text: string): string {
  if (!hasNativeBindings()) {
    return sanitizeBinaryFallback(text);
  }

  return (native as Record<string, Function>).sanitizeBinaryOutputNative(text) as string;
}
