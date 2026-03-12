import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import { checkExistingEnvKeys, detectDestination } from "../../get-secrets-from-user.ts";

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
