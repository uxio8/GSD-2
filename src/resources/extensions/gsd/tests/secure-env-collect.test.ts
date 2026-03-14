import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import {
  checkExistingEnvKeys,
  collectSecretsFromManifest,
  detectDestination,
  showSecretsSummary,
} from "../../get-secrets-from-user.ts";
import { getManifestStatus, parseSecretsManifest } from "../files.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

test("secure_env_collect: checkExistingEnvKeys finds keys in .env and process.env", async (t) => {
  const dir = makeTempDir("secure-env-existing");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const previous = process.env.GSD_TEST_EXISTING_SECRET;
  process.env.GSD_TEST_EXISTING_SECRET = "";

  t.after(() => {
    delete process.env.GSD_TEST_EXISTING_SECRET;
    if (previous !== undefined) process.env.GSD_TEST_EXISTING_SECRET = previous;
  });

  const envPath = join(dir, ".env");
  writeFileSync(envPath, "FILE_ONLY_SECRET=abc123\n", "utf-8");

  const result = await checkExistingEnvKeys(
    ["FILE_ONLY_SECRET", "GSD_TEST_EXISTING_SECRET", "MISSING_SECRET"],
    envPath,
  );

  assert.deepEqual(result.sort(), ["FILE_ONLY_SECRET", "GSD_TEST_EXISTING_SECRET"]);
});

test("secure_env_collect: checkExistingEnvKeys handles missing env file", async (t) => {
  const dir = makeTempDir("secure-env-missing");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const previous = process.env.GSD_TEST_MISSING_ENV_FILE;
  process.env.GSD_TEST_MISSING_ENV_FILE = "present";

  t.after(() => {
    delete process.env.GSD_TEST_MISSING_ENV_FILE;
    if (previous !== undefined) process.env.GSD_TEST_MISSING_ENV_FILE = previous;
  });

  const result = await checkExistingEnvKeys(
    ["GSD_TEST_MISSING_ENV_FILE", "ALSO_MISSING"],
    join(dir, ".env.local"),
  );

  assert.deepEqual(result, ["GSD_TEST_MISSING_ENV_FILE"]);
});

test("secure_env_collect: detectDestination prefers vercel over convex and falls back to dotenv", (t) => {
  const vercelDir = makeTempDir("secure-env-vercel");
  const convexDir = makeTempDir("secure-env-convex");
  const plainDir = makeTempDir("secure-env-dotenv");

  t.after(() => {
    rmSync(vercelDir, { recursive: true, force: true });
    rmSync(convexDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  });

  writeFileSync(join(vercelDir, "vercel.json"), "{}\n", "utf-8");
  mkdirSync(join(vercelDir, "convex"));
  mkdirSync(join(convexDir, "convex"));

  assert.equal(detectDestination(vercelDir), "vercel");
  assert.equal(detectDestination(convexDir), "convex");
  assert.equal(detectDestination(plainDir), "dotenv");
});

test("secrets manifest parser and status distinguish env-backed keys from pending ones", async (t) => {
  const dir = makeTempDir("secure-env-manifest");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(dir, ".env"), "OPENAI_API_KEY=present\n", "utf-8");
  const manifestPath = join(dir, ".gsd", "milestones", "M001", "M001-SECRETS.md");
  writeFileSync(manifestPath, [
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
    "",
    "### STRIPE_SECRET_KEY",
    "",
    "**Service:** Stripe",
    "**Dashboard:** https://dashboard.stripe.com/apikeys",
    "**Format hint:** sk_live_...",
    "**Status:** pending",
    "**Destination:** dotenv",
    "",
    "1. Open the dashboard",
  ].join("\n"), "utf-8");

  const parsed = parseSecretsManifest(readFileSync(manifestPath, "utf-8"));
  const status = await getManifestStatus(dir, "M001");

  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(status, {
    pending: ["STRIPE_SECRET_KEY"],
    collected: [],
    skipped: [],
    existing: ["OPENAI_API_KEY"],
  });
});

test("collectSecretsFromManifest only prompts for pending keys and updates the manifest", async (t) => {
  const dir = makeTempDir("secure-env-collect-manifest");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  mkdirSync(join(dir, ".gsd", "milestones", "M001"), { recursive: true });
  const manifestPath = join(dir, ".gsd", "milestones", "M001", "M001-SECRETS.md");
  writeFileSync(manifestPath, [
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

  const responses = [undefined, "sk-test-value"];
  const result = await collectSecretsFromManifest(
    dir,
    "M001",
    {
      hasUI: true,
      ui: {
        custom: async () => responses.shift(),
      },
    },
    { cwd: dir },
  );

  assert.deepEqual(result.applied, ["OPENAI_API_KEY"]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.existingSkipped, []);
  assert.deepEqual(result.errors, []);
  assert.match(readFileSync(join(dir, ".env"), "utf-8"), /OPENAI_API_KEY=sk-test-value/);
  assert.match(readFileSync(manifestPath, "utf-8"), /\*\*Status:\*\* collected/);
});

test("showSecretsSummary resolves cleanly when the user continues without a payload", async () => {
  let resolvedValue: null | undefined;

  await showSecretsSummary(
    {
      hasUI: true,
      ui: {
        custom: async (factory: (tui: any, theme: any, kb: any, done: (result: null) => void) => { handleInput: (data: string) => void }) => {
          await new Promise<void>((resolve) => {
            const component = factory(
              { requestRender() {} },
              { fg: (_name: string, value: string) => value, bold: (value: string) => value },
              null,
              (result: null) => {
                resolvedValue = result;
                resolve();
              },
            );
            component.handleInput(" ");
          });
        },
      },
    },
    [{ key: "OPENAI_API_KEY", service: "OpenAI", destination: "dotenv", status: "pending" }],
    [],
  );

  assert.equal(resolvedValue, null);
});
