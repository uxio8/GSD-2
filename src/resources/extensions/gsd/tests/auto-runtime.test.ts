import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const autoModuleUrl = new URL("../auto.ts", import.meta.url).href;

async function importAutoModule(seed: string) {
  return import(`${autoModuleUrl}?test=${seed}`);
}

test("applyPreferredModelForUnit falls back when the primary model fails", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "gsd-auto-home-"));
  const project = mkdtempSync(join(tmpdir(), "gsd-auto-project-"));
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
    "  planning:",
    "    model: claude-opus-4-6",
    "    fallbacks:",
    "      - openrouter/z-ai/glm-5",
    "---",
  ].join("\n"), "utf-8");

  const { applyPreferredModelForUnit } = await importAutoModule(`model-${Date.now()}`);
  const notifications: Array<{ message: string; level: string }> = [];
  const attempted: string[] = [];

  await applyPreferredModelForUnit(
    {
      modelRegistry: {
        getAll: () => [
          { provider: "anthropic", id: "claude-opus-4-6" },
          { provider: "openrouter", id: "z-ai/glm-5" },
        ],
      } as any,
      ui: {
        notify: (message: string, level: string) => notifications.push({ message, level }),
      } as any,
    },
    {
      setModel: async (model: any) => {
        attempted.push(`${model.provider}/${model.id}`);
        return model.provider === "openrouter";
      },
    },
    "plan-slice",
  );

  assert.deepEqual(attempted, ["anthropic/claude-opus-4-6", "openrouter/z-ai/glm-5"]);
  assert.equal(notifications.some((entry) => entry.message.includes("fallback from claude-opus-4-6")), true);
  await assert.rejects(
    applyPreferredModelForUnit(
      {
        modelRegistry: {
          getAll: () => [
            { provider: "anthropic", id: "claude-opus-4-6" },
            { provider: "openrouter", id: "z-ai/glm-5" },
          ],
        } as any,
        ui: {
          notify: () => {},
        } as any,
      },
      {
        setModel: async () => false,
      },
      "plan-slice",
    ),
    /Could not set any preferred model for plan-slice/,
  );
});

test("maybeCollectProactiveSecrets skips prompting when secrets are already satisfied", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "gsd-auto-home-"));
  const project = mkdtempSync(join(tmpdir(), "gsd-auto-project-"));
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

  mkdirSync(join(project, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(project, ".gsd", "preferences.md"), [
    "---",
    "version: 1",
    "secrets:",
    "  proactive_collect: true",
    "---",
  ].join("\n"), "utf-8");
  writeFileSync(join(project, ".env"), "OPENAI_API_KEY=existing-key\n", "utf-8");
  writeFileSync(join(project, ".gsd", "milestones", "M001", "M001-SECRETS.md"), [
    "# Secrets Manifest",
    "",
    "**Milestone:** M001",
    "**Generated:** 2026-03-13T00:00:00Z",
    "",
    "### OPENAI_API_KEY",
    "",
    "**Service:** OpenAI",
    "**Dashboard:** https://platform.openai.com/api-keys",
    "**Format hint:** sk-...",
    "**Status:** pending",
    "**Destination:** dotenv",
    "",
    "1. Open the dashboard",
  ].join("\n"), "utf-8");

  const { maybeCollectProactiveSecrets } = await importAutoModule(`secrets-${Date.now()}`);
  let customCalls = 0;
  const result = await maybeCollectProactiveSecrets(project, "M001", {
    hasUI: true,
    ui: {
      custom: async () => {
        customCalls += 1;
        return undefined;
      },
      notify: () => {},
    } as any,
  });

  assert.equal(result, null);
  assert.equal(customCalls, 0);
});
