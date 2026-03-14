import test from "node:test";
import assert from "node:assert/strict";

const { Markdown } = await import(
  new URL("../../node_modules/@mariozechner/pi-tui/dist/components/markdown.js?patched", import.meta.url).href,
);
const { visibleWidth } = await import(
  new URL("../../node_modules/@mariozechner/pi-tui/dist/utils.js?patched", import.meta.url).href,
);

const identity = (value: string) => value;
const theme = {
  heading: identity,
  bold: identity,
  underline: identity,
  italic: identity,
  strikethrough: identity,
  codeBlockBorder: identity,
  codeBlock: identity,
  quoteBar: identity,
  quote: identity,
  listBullet: identity,
  link: identity,
  text: identity,
  dim: identity,
  highlightCode: undefined,
  codeBlockIndent: "  ",
};

test("Markdown render truncates oversized wrapped lines inside code blocks", () => {
  const markdown = new Markdown(`\`\`\`txt\n${"x".repeat(500)}\n\`\`\``, 0, 0, theme);
  const lines = markdown.render(40);

  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 40, `rendered line exceeded width: ${visibleWidth(line)}`);
  }
});
