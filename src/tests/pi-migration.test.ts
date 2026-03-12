import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { AuthStorage } from "@mariozechner/pi-coding-agent";

const migrationModuleUrl = pathToFileURL(
  join(process.cwd(), "src", "pi-migration.ts"),
).href;

async function importMigrationModule(seed: string) {
  return import(`${migrationModuleUrl}?test=${seed}`);
}

test("migratePiCredentials imports Pi auth when GSD has no LLM providers", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "gsd-pi-home-"));
  const authPath = join(home, "gsd-auth.json");
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  t.after(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(home, { recursive: true, force: true });
  });

  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: "anthropic-key" },
      tavily: { type: "api_key", key: "tavily-key" },
    }),
    "utf-8",
  );

  const auth = AuthStorage.create(authPath);
  const { migratePiCredentials } = await importMigrationModule(`migrate-${Date.now()}`);
  const migrated = migratePiCredentials(auth);

  assert.equal(migrated, true);
  assert.equal(auth.has("anthropic"), true);
  assert.equal(auth.has("tavily"), true);

  const saved = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, any>;
  assert.equal(saved.anthropic.key, "anthropic-key");
});

test("migratePiCredentials skips when GSD already has an LLM provider", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "gsd-pi-home-"));
  const authPath = join(home, "gsd-auth.json");
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  t.after(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(home, { recursive: true, force: true });
  });

  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: "pi-key" },
    }),
    "utf-8",
  );

  const auth = AuthStorage.create(authPath);
  auth.set("openai", { type: "api_key", key: "existing-key" } as any);

  const { migratePiCredentials } = await importMigrationModule(`skip-${Date.now()}`);
  const migrated = migratePiCredentials(auth);

  assert.equal(migrated, false);
  assert.equal(auth.has("anthropic"), false);
});

test("migratePiCredentials is a no-op when Pi auth is missing", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "gsd-pi-home-"));
  const authPath = join(home, "gsd-auth.json");
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  t.after(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(home, { recursive: true, force: true });
  });

  const auth = AuthStorage.create(authPath);
  const { migratePiCredentials } = await importMigrationModule(`missing-${Date.now()}`);

  assert.equal(migratePiCredentials(auth), false);
  assert.equal(auth.list().length, 0);
});
