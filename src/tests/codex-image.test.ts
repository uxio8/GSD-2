import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import registerCodexImageExtension, {
  buildCodexImageExecArgs,
  buildCodexImageExecPrompt,
  resolveCodexImageConfig,
  resolveCodexImageOutputPath,
} from "../resources/extensions/codex-image/index.ts";
import { initResources } from "../resource-loader.ts";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

function makeJwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function makeStubTool() {
  let registered: any = null;
  registerCodexImageExtension({
    registerTool(definition: unknown) {
      registered = definition;
    },
  } as any);
  return registered;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

test("codex-image config merges global defaults with project overrides", () => {
  const home = mkdtempSync(join(tmpdir(), "gsd-codex-image-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "gsd-codex-image-cwd-"));
  const originalHome = process.env.HOME;

  try {
    process.env.HOME = home;
    mkdirSync(join(home, ".gsd", "agent", "extensions"), { recursive: true });
    mkdirSync(join(cwd, ".gsd", "extensions"), { recursive: true });

    writeFileSync(
      join(home, ".gsd", "agent", "extensions", "codex-image.json"),
      JSON.stringify({
        enabled: false,
        codexCommand: "/usr/local/bin/codex-global",
        defaultOutputDir: ".gsd/global-images",
        timeoutSec: 321,
      }),
      "utf8",
    );
    writeFileSync(
      join(cwd, ".gsd", "extensions", "codex-image.json"),
      JSON.stringify({
        enabled: true,
        timeoutSec: 222,
      }),
      "utf8",
    );

    const config = resolveCodexImageConfig(cwd);
    assert.deepEqual(config, {
      enabled: true,
      codexCommand: "/usr/local/bin/codex-global",
      defaultOutputDir: ".gsd/global-images",
      timeoutSec: 222,
    });
  } finally {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("codex-image defaults to disabled until the CLI lane supports native image generation", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-codex-image-default-disabled-"));

  try {
    const config = resolveCodexImageConfig(cwd);
    assert.equal(config.enabled, false);
    assert.equal(config.codexCommand, "codex");
    assert.equal(config.defaultOutputDir, ".gsd/generated-images");
    assert.equal(config.timeoutSec, 600);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("codex-image output path stays inside project and defaults to png names", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-codex-image-paths-"));

  try {
    const config = { defaultOutputDir: ".gsd/generated-images" };
    const generated = resolveCodexImageOutputPath({
      cwd,
      prompt: "Moonlit Escape Title Card",
      config,
      now: new Date("2026-03-13T12:34:56.000Z"),
    });
    assert.equal(
      generated,
      join(
        cwd,
        ".gsd",
        "generated-images",
        "2026-03-13T12-34-56-000Z-moonlit-escape-title-card.png",
      ),
    );

    const explicit = resolveCodexImageOutputPath({
      cwd,
      prompt: "ignored",
      outputPath: "assets/covers/hero",
      config,
    });
    assert.equal(explicit, join(cwd, "assets", "covers", "hero.png"));

    assert.throws(
      () =>
        resolveCodexImageOutputPath({
          cwd,
          prompt: "ignored",
          outputPath: "../escape.png",
          config,
        }),
      /must stay inside the project root/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("codex-image builds the expected exec prompt and args", () => {
  const prompt = buildCodexImageExecPrompt({
    prompt: "A cinematic forest at night with silver mist.",
    aspectRatio: "16:9",
    outputPath: "/tmp/out/forest.png",
  });
  assert.match(prompt, /Use the installed skill "gsd-codex-image"/);
  assert.match(prompt, /Aspect ratio: 16:9/);
  assert.match(prompt, /Save it to this exact absolute path: \/tmp\/out\/forest\.png/);

  const args = buildCodexImageExecArgs({
    jobDir: "/tmp/job",
    schemaPath: "/tmp/schema.json",
    manifestPath: "/tmp/manifest.json",
    writableDir: "/tmp/out",
    prompt,
  });
  assert.deepEqual(args, [
    "exec",
    "-C",
    "/tmp/job",
    "--skip-git-repo-check",
    "--output-schema",
    "/tmp/schema.json",
    "--output-last-message",
    "/tmp/manifest.json",
    "--sandbox",
    "workspace-write",
    "--add-dir",
    "/tmp/out",
    "--model",
    "gpt-5.4",
    "--json",
    prompt,
  ]);
});

test("codex-image registers an LLM-callable tool with guardrails", () => {
  const tool = makeStubTool();
  assert.equal(tool.name, "codex_generate_image");
  assert.equal(tool.label, "Codex Generate Image");
  assert.equal(typeof tool.execute, "function");
  assert.ok(Array.isArray(tool.promptGuidelines));
  assert.ok(tool.promptGuidelines.some((line: string) => line.includes("diagrams")));
});

test("codex-image returns a clear disabled error when not opted in", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-codex-image-disabled-tool-"));

  try {
    const tool = makeStubTool();
    const result = await tool.execute(
      "tool-call-disabled",
      { prompt: "A premium title card." },
      undefined,
      undefined,
      { cwd } as any,
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /disabled by config/i);
    assert.match(result.content[0].text, /does not expose native image generation/i);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("codex-image retries once on usage limit and returns an inline image", async () => {
  const home = mkdtempSync(join(tmpdir(), "gsd-codex-image-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "gsd-codex-image-project-"));
  const stateFile = join(tmpdir(), `gsd-codex-image-state-${Date.now()}.txt`);
  const fakeCodex = join(home, "fake-codex.mjs");
  const envPath = join(home, "cloud-pool.env");
  const originalHome = process.env.HOME;
  const originalPackageRoot = process.env.GSD_PACKAGE_ROOT;
  const originalAgentDir = process.env.GSD_AGENT_DIR;
  const originalEnvFile = process.env.GSD_CLOUD_POOL_ENV_FILE;
  const originalUrl = process.env.GSD_CLOUD_POOL_URL;
  const originalToken = process.env.GSD_CLOUD_POOL_TOKEN;
  const originalSlug = process.env.GSD_CLOUD_POOL_SLUG;
  const originalMode = process.env.FAKE_CODEX_MODE;
  const originalState = process.env.FAKE_CODEX_STATE;

  const accessTokenOne = makeJwt({
    exp: 1_950_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-one" },
  });
  const accessTokenTwo = makeJwt({
    exp: 1_960_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-two" },
  });

  const requestBodies: Array<{ url: string; body: string }> = [];
  let acquireCount = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requestBodies.push({ url: req.url ?? "", body });

      if (req.url === "/v1/pools/main/leases/acquire" && req.method === "POST") {
        acquireCount += 1;
        const leaseId = acquireCount === 1 ? "lease-one" : "lease-two";
        const sessionId = acquireCount === 1 ? "session-one" : "session-two";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ leaseId, accountId: `acct-${acquireCount}`, sessionId }));
        return;
      }

      if (req.url === "/v1/leases/lease-one/auth-snapshot" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            tokens: {
              access_token: accessTokenOne,
              refresh_token: "refresh-one",
              account_id: "acct-one",
            },
          }),
        );
        return;
      }

      if (req.url === "/v1/leases/lease-two/auth-snapshot" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            tokens: {
              access_token: accessTokenTwo,
              refresh_token: "refresh-two",
              account_id: "acct-two",
            },
          }),
        );
        return;
      }

      if (
        req.url === "/v1/leases/lease-one/complete" ||
        req.url === "/v1/leases/lease-two/complete" ||
        req.url === "/v1/leases/lease-one/release" ||
        req.url === "/v1/leases/lease-two/release" ||
        req.url === "/v1/leases/lease-one/renew" ||
        req.url === "/v1/leases/lease-two/renew"
      ) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind fake cloud pool");
  }

  try {
    process.env.HOME = home;
    process.env.GSD_PACKAGE_ROOT = projectRoot;
    process.env.GSD_AGENT_DIR = join(home, ".gsd", "agent");
    process.env.GSD_CLOUD_POOL_ENV_FILE = envPath;
    delete process.env.GSD_CLOUD_POOL_URL;
    delete process.env.GSD_CLOUD_POOL_TOKEN;
    delete process.env.GSD_CLOUD_POOL_SLUG;
    process.env.FAKE_CODEX_MODE = "usage_then_success";
    process.env.FAKE_CODEX_STATE = stateFile;

    initResources(process.env.GSD_AGENT_DIR);

    mkdirSync(join(home, ".gsd", "agent", "extensions"), { recursive: true });
    writeFileSync(
      join(home, ".gsd", "agent", "extensions", "codex-image.json"),
      JSON.stringify({
        enabled: true,
        codexCommand: fakeCodex,
        timeoutSec: 30,
      }),
      "utf8",
    );
    writeFileSync(
      envPath,
      `POOL_URL=http://127.0.0.1:${address.port}\nPOOL_TOKEN=test-token\nPOOL_SLUG=main\n`,
      "utf8",
    );

    writeExecutable(
      fakeCodex,
      `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const manifestPath = args[args.indexOf("--output-last-message") + 1];
const prompt = args[args.length - 1];
const stateFile = process.env.FAKE_CODEX_STATE;
const mode = process.env.FAKE_CODEX_MODE;
const count = existsSync(stateFile) ? Number(readFileSync(stateFile, "utf8") || "0") : 0;
writeFileSync(stateFile, String(count + 1));

if (mode === "usage_then_success" && count === 0) {
  console.error("You have hit your ChatGPT usage limit (team plan). Try again in ~90 min.");
  process.exit(1);
}

const match = prompt.match(/Save it to this exact absolute path: (.+)/);
if (!match) {
  console.error("missing output path");
  process.exit(1);
}

const outputPath = match[1].trim();
const skillPath = join(process.env.CODEX_HOME, "skills", "gsd-codex-image", "SKILL.md");
if (!existsSync(skillPath)) {
  console.error("missing bundled skill");
  process.exit(1);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2F7mQAAAAASUVORK5CYII=", "base64"),
);

mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(
  manifestPath,
  JSON.stringify({
    saved_path: outputPath,
    mime_type: "image/png",
    notes: "Generated by fake codex.",
  }),
  "utf8",
);

console.log(JSON.stringify({ type: "thread.started" }));
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    );

    const tool = makeStubTool();
    const result = await tool.execute(
      "tool-call-1",
      {
        prompt: "A cinematic moonlit forest background for a mobile story game.",
        aspectRatio: "16:9",
      },
      undefined,
      undefined,
      { cwd } as any,
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[1].type, "image");
    assert.equal(result.details.retryCount, 1);
    assert.ok(result.details.savedPath.endsWith(".png"));
    assert.ok(existsSync(result.details.savedPath));
    assert.match(result.content[0].text, /Source: codex-pool/);

    const completeBodies = requestBodies
      .filter((entry) => entry.url.endsWith("/complete"))
      .map((entry) => JSON.parse(entry.body));
    assert.equal(completeBodies[0].outcome, "usage_limited");
    assert.equal(completeBodies[1].outcome, "succeeded");
  } finally {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalPackageRoot) process.env.GSD_PACKAGE_ROOT = originalPackageRoot;
    else delete process.env.GSD_PACKAGE_ROOT;
    if (originalAgentDir) process.env.GSD_AGENT_DIR = originalAgentDir;
    else delete process.env.GSD_AGENT_DIR;
    if (originalEnvFile) process.env.GSD_CLOUD_POOL_ENV_FILE = originalEnvFile;
    else delete process.env.GSD_CLOUD_POOL_ENV_FILE;
    if (originalUrl) process.env.GSD_CLOUD_POOL_URL = originalUrl;
    else delete process.env.GSD_CLOUD_POOL_URL;
    if (originalToken) process.env.GSD_CLOUD_POOL_TOKEN = originalToken;
    else delete process.env.GSD_CLOUD_POOL_TOKEN;
    if (originalSlug) process.env.GSD_CLOUD_POOL_SLUG = originalSlug;
    else delete process.env.GSD_CLOUD_POOL_SLUG;
    if (originalMode) process.env.FAKE_CODEX_MODE = originalMode;
    else delete process.env.FAKE_CODEX_MODE;
    if (originalState) process.env.FAKE_CODEX_STATE = originalState;
    else delete process.env.FAKE_CODEX_STATE;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(stateFile, { force: true });
  }
});

test("codex-image fails closed when the pool has no capacity", async () => {
  const home = mkdtempSync(join(tmpdir(), "gsd-codex-image-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "gsd-codex-image-project-"));
  const envPath = join(home, "cloud-pool.env");
  const originalHome = process.env.HOME;
  const originalPackageRoot = process.env.GSD_PACKAGE_ROOT;
  const originalAgentDir = process.env.GSD_AGENT_DIR;
  const originalEnvFile = process.env.GSD_CLOUD_POOL_ENV_FILE;

  const server = http.createServer((req, res) => {
    if (req.url === "/v1/pools/main/leases/acquire" && req.method === "POST") {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "pool has no capacity" }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind fake cloud pool");
  }

  try {
    process.env.HOME = home;
    process.env.GSD_PACKAGE_ROOT = projectRoot;
    process.env.GSD_AGENT_DIR = join(home, ".gsd", "agent");
    process.env.GSD_CLOUD_POOL_ENV_FILE = envPath;
    initResources(process.env.GSD_AGENT_DIR);
    mkdirSync(join(home, ".gsd", "agent", "extensions"), { recursive: true });
    writeFileSync(
      join(home, ".gsd", "agent", "extensions", "codex-image.json"),
      JSON.stringify({
        enabled: true,
      }),
      "utf8",
    );
    writeFileSync(
      envPath,
      `POOL_URL=http://127.0.0.1:${address.port}\nPOOL_TOKEN=test-token\nPOOL_SLUG=main\n`,
      "utf8",
    );

    const tool = makeStubTool();
    const result = await tool.execute(
      "tool-call-2",
      { prompt: "A key art cover." },
      undefined,
      undefined,
      { cwd } as any,
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /failed without falling back to any external API/i);
    assert.match(result.content[0].text, /pool has no capacity/i);
  } finally {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalPackageRoot) process.env.GSD_PACKAGE_ROOT = originalPackageRoot;
    else delete process.env.GSD_PACKAGE_ROOT;
    if (originalAgentDir) process.env.GSD_AGENT_DIR = originalAgentDir;
    else delete process.env.GSD_AGENT_DIR;
    if (originalEnvFile) process.env.GSD_CLOUD_POOL_ENV_FILE = originalEnvFile;
    else delete process.env.GSD_CLOUD_POOL_ENV_FILE;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("codex-image reports unavailable native image capability without ENOENT noise", async () => {
  const home = mkdtempSync(join(tmpdir(), "gsd-codex-image-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "gsd-codex-image-project-"));
  const fakeCodex = join(home, "fake-codex-unavailable.mjs");
  const envPath = join(home, "cloud-pool.env");
  const originalHome = process.env.HOME;
  const originalPackageRoot = process.env.GSD_PACKAGE_ROOT;
  const originalAgentDir = process.env.GSD_AGENT_DIR;
  const originalEnvFile = process.env.GSD_CLOUD_POOL_ENV_FILE;

  const accessToken = makeJwt({
    exp: 1_950_000_000,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-unavailable" },
  });

  const completeBodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.url === "/v1/pools/main/leases/acquire" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ leaseId: "lease-unavailable", accountId: "acct-unavailable", sessionId: "session-unavailable" }));
        return;
      }

      if (req.url === "/v1/leases/lease-unavailable/auth-snapshot" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            tokens: {
              access_token: accessToken,
              refresh_token: "refresh-unavailable",
              account_id: "acct-unavailable",
            },
          }),
        );
        return;
      }

      if (req.url === "/v1/leases/lease-unavailable/complete" && req.method === "POST") {
        completeBodies.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.url === "/v1/leases/lease-unavailable/release" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.url === "/v1/leases/lease-unavailable/renew" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind fake cloud pool");
  }

  try {
    process.env.HOME = home;
    process.env.GSD_PACKAGE_ROOT = projectRoot;
    process.env.GSD_AGENT_DIR = join(home, ".gsd", "agent");
    process.env.GSD_CLOUD_POOL_ENV_FILE = envPath;

    initResources(process.env.GSD_AGENT_DIR);
    mkdirSync(join(home, ".gsd", "agent", "extensions"), { recursive: true });
    writeFileSync(
      join(home, ".gsd", "agent", "extensions", "codex-image.json"),
      JSON.stringify({
        enabled: true,
        codexCommand: fakeCodex,
        timeoutSec: 30,
      }),
      "utf8",
    );
    writeFileSync(
      envPath,
      `POOL_URL=http://127.0.0.1:${address.port}\nPOOL_TOKEN=test-token\nPOOL_SLUG=main\n`,
      "utf8",
    );
    writeExecutable(
      fakeCodex,
      `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const args = process.argv.slice(2);
const manifestPath = args[args.indexOf("--output-last-message") + 1];
const prompt = args[args.length - 1];
const match = prompt.match(/Save it to this exact absolute path: (.+)/);
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, JSON.stringify({
  saved_path: match ? match[1].trim() : "missing-output-path.png",
  mime_type: "image/png",
  notes: "Native image generation is unavailable in this Codex session, so no image was created."
}), "utf8");
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    );

    const tool = makeStubTool();
    const result = await tool.execute(
      "tool-call-3",
      { prompt: "A premium cover illustration." },
      undefined,
      undefined,
      { cwd } as any,
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Codex image generation is unavailable/i);
    assert.doesNotMatch(result.content[0].text, /ENOENT/);
    assert.equal((completeBodies[0] as any).outcome, "failed");
  } finally {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalPackageRoot) process.env.GSD_PACKAGE_ROOT = originalPackageRoot;
    else delete process.env.GSD_PACKAGE_ROOT;
    if (originalAgentDir) process.env.GSD_AGENT_DIR = originalAgentDir;
    else delete process.env.GSD_AGENT_DIR;
    if (originalEnvFile) process.env.GSD_CLOUD_POOL_ENV_FILE = originalEnvFile;
    else delete process.env.GSD_CLOUD_POOL_ENV_FILE;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
