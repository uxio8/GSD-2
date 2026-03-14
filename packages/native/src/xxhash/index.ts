/**
 * Native xxHash32 — Rust implementation via napi-rs.
 *
 * Hashes the UTF-8 representation of the input string with the given seed.
 */

import { hasNativeBindings, native } from "../native.js";

const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

function rotl32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function imul32(a: number, b: number): number {
  return Math.imul(a, b) >>> 0;
}

export function xxHash32Fallback(input: string, seed: number): number {
  const buffer = Buffer.from(input, "utf8");
  const length = buffer.length;
  let hash: number;
  let index = 0;

  if (length >= 16) {
    let v1 = (seed + PRIME32_1 + PRIME32_2) >>> 0;
    let v2 = (seed + PRIME32_2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - PRIME32_1) >>> 0;

    while (index <= length - 16) {
      v1 = imul32(rotl32((v1 + imul32(buffer.readUInt32LE(index), PRIME32_2)) >>> 0, 13), PRIME32_1); index += 4;
      v2 = imul32(rotl32((v2 + imul32(buffer.readUInt32LE(index), PRIME32_2)) >>> 0, 13), PRIME32_1); index += 4;
      v3 = imul32(rotl32((v3 + imul32(buffer.readUInt32LE(index), PRIME32_2)) >>> 0, 13), PRIME32_1); index += 4;
      v4 = imul32(rotl32((v4 + imul32(buffer.readUInt32LE(index), PRIME32_2)) >>> 0, 13), PRIME32_1); index += 4;
    }

    hash = (rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18)) >>> 0;
  } else {
    hash = (seed + PRIME32_5) >>> 0;
  }

  hash = (hash + length) >>> 0;

  while (index <= length - 4) {
    hash = (hash + imul32(buffer.readUInt32LE(index), PRIME32_3)) >>> 0;
    hash = imul32(rotl32(hash, 17), PRIME32_4);
    index += 4;
  }

  while (index < length) {
    hash = (hash + imul32(buffer[index], PRIME32_5)) >>> 0;
    hash = imul32(rotl32(hash, 11), PRIME32_1);
    index += 1;
  }

  hash = imul32(hash ^ (hash >>> 15), PRIME32_2);
  hash = imul32(hash ^ (hash >>> 13), PRIME32_3);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * Compute xxHash32 of a UTF-8 string.
 *
 * @param input  The string to hash (encoded as UTF-8 internally).
 * @param seed   32-bit seed value.
 * @returns      32-bit unsigned hash.
 */
export function xxHash32(input: string, seed: number): number {
  if (!hasNativeBindings() || typeof native.xxHash32 !== "function") {
    return xxHash32Fallback(input, seed);
  }

  return native.xxHash32(input, seed);
}
