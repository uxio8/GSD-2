import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const preferencesModuleUrl = new URL("../preferences.ts", import.meta.url).href;

async function importPreferencesModule(seed: string) {
  return import(`${preferencesModuleUrl}?test=${seed}`);
}

test("resolveModelWithFallbacksForUnit supports legacy and object config", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "gsd-prefs-home-"));
  const project = mkdtempSync(join(tmpdir(), "gsd-prefs-project-"));
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(project);

  t.after(() => {
    process.chdir(originalCwd);
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  mkdirSync(join(project, ".gsd"), { recursive: true });
  writeFileSync(join(project, ".gsd", "preferences.md"), [
    "---",
    "version: 1",
    "models:",
    "  research: claude-sonnet-4-6",
    "  planning:",
    "    model: claude-opus-4-6",
    "    fallbacks:",
    "      - openrouter/z-ai/glm-5",
    "      - openrouter/minimax/minimax-m2.5",
    "secrets:",
    "  proactive_collect: true",
    "---",
  ].join("\n"), "utf-8");

  const module = await importPreferencesModule(`prefs-${Date.now()}`);
  const planning = module.resolveModelWithFallbacksForUnit("plan-slice");
  const research = module.resolveModelWithFallbacksForUnit("research-slice");

  assert.deepEqual(planning, {
    primary: "claude-opus-4-6",
    fallbacks: ["openrouter/z-ai/glm-5", "openrouter/minimax/minimax-m2.5"],
  });
  assert.deepEqual(research, {
    primary: "claude-sonnet-4-6",
    fallbacks: [],
  });
  assert.equal(module.resolveModelForUnit("plan-slice"), "claude-opus-4-6");
  assert.equal(module.resolveProactiveSecretsEnabled(), true);
});
