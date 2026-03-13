import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRules } from "../resources/extensions/ttsr/rule-loader.ts";

function makeTmpProject(): { cwd: string; projectDir: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "ttsr-loader-test-"));
  const projectDir = join(cwd, ".gsd", "rules");
  return {
    cwd,
    projectDir,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function writeRule(dir: string, name: string, frontmatter: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`);
}

test("loadRules loads project-local rules and parses metadata arrays", () => {
  const { cwd, projectDir, cleanup } = makeTmpProject();
  try {
    writeRule(
      projectDir,
      "scoped-rule",
      'condition:\n  - "TODO"\nscope:\n  - "tool:edit"\n  - "text"\nglobs:\n  - "*.ts"',
      "No TODOs allowed.",
    );

    const rule = loadRules(cwd).find((entry) => entry.name === "scoped-rule");
    assert.ok(rule);
    assert.deepEqual(rule.condition, ["TODO"]);
    assert.deepEqual(rule.scope, ["tool:edit", "text"]);
    assert.deepEqual(rule.globs, ["*.ts"]);
    assert.equal(rule.content, "No TODOs allowed.");
  } finally {
    cleanup();
  }
});

test("loadRules skips invalid rule files", () => {
  const { cwd, projectDir, cleanup } = makeTmpProject();
  try {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "broken.md"), "No frontmatter here.");
    writeRule(projectDir, "no-condition", 'scope:\n  - "text"', "Missing condition field.");
    const rules = loadRules(cwd);
    assert.equal(rules.some((entry) => entry.name === "broken"), false);
    assert.equal(rules.some((entry) => entry.name === "no-condition"), false);
  } finally {
    cleanup();
  }
});
