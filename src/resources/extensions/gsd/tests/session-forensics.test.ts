import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getDeepDiagnostic } from "../session-forensics.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function createBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-session-forensics-test-"));
  mkdirSync(join(base, ".gsd", "activity"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

{
  console.log("\n=== getDeepDiagnostic: scopes activity log to last auto unit ===");
  const base = createBase();
  try {
    const activityPath = join(base, ".gsd", "activity", "001-execute-task-M003-S01-T01.jsonl");
    const entries = [
      { type: "custom_message", customType: "gsd-auto", content: "first unit" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "write-old",
              name: "write",
              arguments: { path: "old.txt", content: "old" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "write-old",
          toolName: "write",
          isError: false,
          content: [{ type: "text", text: "ok" }],
        },
      },
      { type: "custom_message", customType: "gsd-auto", content: "second unit" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "write-new",
              name: "write",
              arguments: { path: "new.txt", content: "new" },
            },
            {
              type: "toolCall",
              id: "bash-new",
              name: "bash",
              arguments: { command: "npm test -- --run tests/story/published-experiences.test.ts" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "write-new",
          toolName: "write",
          isError: false,
          content: [{ type: "text", text: "ok" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "bash-new",
          toolName: "bash",
          isError: true,
          content: [{ type: "text", text: "context_length_exceeded" }],
        },
      },
    ];

    writeFileSync(activityPath, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf-8");

    const diagnostic = getDeepDiagnostic(base);
    assert(!!diagnostic, "should produce a diagnostic");
    assert(diagnostic!.includes("new.txt"), "should include files from the last auto unit");
    assert(diagnostic!.includes("npm test -- --run tests/story/published-experiences.test.ts"), "should include commands from the last auto unit");
    assert(!diagnostic!.includes("old.txt"), "should exclude files from earlier auto units in the same log");
  } finally {
    cleanup(base);
  }
}

{
  console.log("\n=== getDeepDiagnostic: parses trailing entries from oversized activity log ===");
  const base = createBase();
  try {
    const activityPath = join(base, ".gsd", "activity", "002-execute-task-M003-S01-T02.jsonl");
    const oversizedEntry = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "x".repeat(11 * 1024 * 1024) }],
      },
    });
    const trailingEntries = [
      { type: "custom_message", customType: "gsd-auto", content: "last unit" },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "write-last",
              name: "write",
              arguments: { path: "last.txt", content: "ok" },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "write-last",
          toolName: "write",
          isError: false,
          content: [{ type: "text", text: "ok" }],
        },
      },
    ];

    writeFileSync(
      activityPath,
      `${oversizedEntry}\n${trailingEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf-8",
    );

    const diagnostic = getDeepDiagnostic(base);
    assert(!!diagnostic, "should still produce a diagnostic for oversized logs");
    assert(diagnostic!.includes("last.txt"), "should keep trailing entries within the parse cap");
  } finally {
    cleanup(base);
  }
}

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
} else {
  console.log(`\n${passed} passed, 0 failed`);
}
