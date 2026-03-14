import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { truncateHead, truncateOutput, truncateTail } from "@gsd/native";

// ── truncateTail ─────────────────────────────────────────────────────────

describe("truncateTail", () => {
  test("no truncation when content fits", () => {
    const r = truncateTail("hello\nworld\n", 100);
    assert.equal(r.truncated, false);
    assert.equal(r.text, "hello\nworld\n");
    assert.equal(r.originalLines, 2);
    assert.equal(r.keptLines, 2);
  });

  test("truncates at line boundary (ASCII)", () => {
    const r = truncateTail("hello\nworld\n", 7);
    assert.equal(r.truncated, true);
    assert.equal(r.text, "hello\n");
    assert.equal(r.keptLines, 1);
  });

  test("empty input", () => {
    const r = truncateTail("", 100);
    assert.equal(r.truncated, false);
    assert.equal(r.originalLines, 0);
  });

  test("exact boundary", () => {
    const r = truncateTail("abc\ndef\n", 8);
    assert.equal(r.truncated, false);
    assert.equal(r.text, "abc\ndef\n");
  });

  test("single line exceeding limit", () => {
    const r = truncateTail("this_is_very_long", 5);
    assert.equal(r.truncated, true);
    assert.equal(r.text, "");
    assert.equal(r.keptLines, 0);
  });

  test("UTF-8 multibyte characters", () => {
    // "日本\n" = 7 bytes (3+3+1)
    const r = truncateTail("日本\nworld\n", 8);
    assert.equal(r.truncated, true);
    assert.equal(r.text, "日本\n");
    assert.equal(r.keptLines, 1);
  });

  test("emoji (4-byte UTF-8)", () => {
    // "😀\n" = 5 bytes
    const r = truncateTail("😀\n😂\n🎉\n", 6);
    assert.equal(r.truncated, true);
    assert.equal(r.text, "😀\n");
    assert.equal(r.keptLines, 1);
  });
});

// ── truncateHead ─────────────────────────────────────────────────────────

describe("truncateHead", () => {
  test("no truncation when content fits", () => {
    const r = truncateHead("hello\nworld\n", 100);
    assert.equal(r.truncated, false);
    assert.equal(r.text, "hello\nworld\n");
  });

  test("keeps last lines (ASCII)", () => {
    const r = truncateHead("hello\nworld\n", 7);
    assert.equal(r.truncated, true);
    assert.equal(r.text, "world\n");
    assert.equal(r.keptLines, 1);
  });

  test("empty input", () => {
    const r = truncateHead("", 100);
    assert.equal(r.truncated, false);
  });

  test("single line exceeding limit", () => {
    const r = truncateHead("this_is_very_long", 5);
    assert.equal(r.truncated, true);
    assert.equal(r.text, "");
    assert.equal(r.keptLines, 0);
  });
});

// ── truncateOutput ───────────────────────────────────────────────────────

describe("truncateOutput", () => {
  test("no truncation when fits", () => {
    const r = truncateOutput("small", 100);
    assert.equal(r.truncated, false);
    assert.equal(r.text, "small");
    assert.equal(r.message, null);
  });

  test("tail mode (default)", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const r = truncateOutput(lines, 200);
    assert.equal(r.truncated, true);
    assert.ok(r.message);
  });

  test("head mode", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const r = truncateOutput(lines, 200, "head");
    assert.equal(r.truncated, true);
    assert.ok(r.message.includes("start"));
  });

  test("both mode", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const r = truncateOutput(lines, 200, "both");
    assert.equal(r.truncated, true);
    assert.ok(r.text.includes("... ["));
  });
});
