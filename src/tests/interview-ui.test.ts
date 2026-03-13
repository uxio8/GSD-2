import test from "node:test";
import assert from "node:assert/strict";
import { getEditorNotesText } from "../resources/extensions/shared/interview-ui.ts";

test("getEditorNotesText preserves expanded pasted content", () => {
  const longPastedText = "voice transcript ".repeat(120);
  const notes = getEditorNotesText({
    getExpandedText: () => `  ${longPastedText}  `,
  });

  assert.equal(notes, longPastedText.trim());
});
