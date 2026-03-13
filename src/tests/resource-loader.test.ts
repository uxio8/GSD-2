import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildResourceLoader, discoverExtensionEntryPaths } from "../resource-loader.ts";

test("discoverExtensionEntryPaths resolves declared package entries and index fallbacks", () => {
  const dir = mkdtempSync(join(tmpdir(), "gsd-resource-loader-"));
  const packaged = join(dir, "packaged");
  const indexed = join(dir, "indexed");
  const direct = join(dir, "direct.ts");

  try {
    mkdirSync(packaged, { recursive: true });
    mkdirSync(indexed, { recursive: true });
    writeFileSync(join(packaged, "package.json"), JSON.stringify({ pi: { extensions: ["src/entry.ts"] } }), "utf-8");
    mkdirSync(join(packaged, "src"), { recursive: true });
    writeFileSync(join(packaged, "src", "entry.ts"), "export default function () {}", "utf-8");
    writeFileSync(join(indexed, "index.ts"), "export default function () {}", "utf-8");
    writeFileSync(direct, "export default function () {}", "utf-8");

    const discovered = discoverExtensionEntryPaths(dir).sort();
    assert.deepEqual(discovered, [
      direct,
      join(indexed, "index.ts"),
      join(packaged, "src", "entry.ts"),
    ].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildResourceLoader layers external Pi extensions without duplicating bundled ones", () => {
  const home = mkdtempSync(join(tmpdir(), "gsd-resource-loader-home-"));
  const agentDir = join(home, ".gsd", "agent");
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  try {
    const piExtensionsDir = join(home, ".pi", "agent", "extensions");
    const external = join(piExtensionsDir, "external-ext");
    const duplicateBundled = join(piExtensionsDir, "gsd");
    mkdirSync(external, { recursive: true });
    mkdirSync(duplicateBundled, { recursive: true });
    writeFileSync(join(external, "index.ts"), "export default function () {}", "utf-8");
    writeFileSync(join(duplicateBundled, "index.ts"), "export default function () {}", "utf-8");

    const loader = buildResourceLoader(agentDir, {
      additionalExtensionPaths: ["/tmp/manual-extension.ts", join(external, "index.ts")],
    });

    assert.deepEqual(loader.additionalExtensionPaths, [
      join(external, "index.ts"),
      "/tmp/manual-extension.ts",
    ]);
  } finally {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(home, { recursive: true, force: true });
  }
});
