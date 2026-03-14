import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

const TOOL_NAME = "codex_generate_image";
const TOOL_LABEL = "Codex Generate Image";
const SKILL_NAME = "gsd-codex-image";
const DEFAULT_OUTPUT_DIR = ".gsd/generated-images";
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_MODEL = "gpt-5.4";
const ASPECT_RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"] as const;

const TOOL_PARAMS = Type.Object({
  prompt: Type.String({
    description: "Describe the original visual asset to generate.",
    minLength: 3,
  }),
  aspectRatio: Type.Optional(StringEnum(ASPECT_RATIOS)),
  outputPath: Type.Optional(
    Type.String({
      description:
        "Optional project-relative output path. Defaults to .gsd/generated-images/<timestamp>-<slug>.png",
    }),
  ),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

export interface CodexImageConfig {
  enabled: boolean;
  codexCommand: string;
  defaultOutputDir: string;
  timeoutSec: number;
}

interface CodexImageManifest {
  saved_path: string;
  mime_type: string;
  notes: string;
}

interface CodexImageRunPaths {
  outputPath: string;
  outputDir: string;
  defaultOutputDir: string;
  runsDir: string;
  runLogPath: string;
  stderrLogPath: string;
}

interface AttemptPaths {
  rootDir: string;
  codexHomeDir: string;
  jobDir: string;
  schemaPath: string;
  manifestPath: string;
}

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

interface CloudPoolModule {
  readCloudPoolConfig: (cwd: string) => CloudPoolConfig | null;
  acquireCloudPoolLease: (config: CloudPoolConfig) => Promise<CloudPoolAcquireResponse>;
  fetchCloudPoolAuthSnapshotText: (config: CloudPoolConfig, leaseId: string) => Promise<string>;
  completeCloudPoolLease: (
    config: CloudPoolConfig,
    leaseId: string,
    input: {
      outcome: CloudPoolCompleteOutcome;
      message?: string;
      usageLimitRetryAt?: Date | null;
    },
  ) => Promise<void>;
  releaseCloudPoolLease: (config: CloudPoolConfig, leaseId: string, reason: string) => Promise<void>;
  renewCloudPoolLease: (config: CloudPoolConfig, leaseId: string) => Promise<void>;
  parseUsageLimitSignal: (message: string, now?: Date) => {
    message: string;
    retryAt: Date | null;
  } | null;
}

interface CloudPoolConfig {
  apiUrl: string;
  apiKey: string;
  poolId: string;
  leaseTtlSec: number;
  consumerId: string;
  clientInstanceId: string;
  consumerType: "remote_runner" | "paperclip_client";
  pinnedSessionId?: string;
  excludedSessionIds: string[];
}

interface CloudPoolAcquireResponse {
  leaseId: string;
  accountId: string | null;
  sessionId: string | null;
}

type CloudPoolCompleteOutcome =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "usage_limited"
  | "auth_invalid";

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readConfigFile(path: string): Partial<CodexImageConfig> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CodexImageConfig>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(trimString(value));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isPathInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const rel = relative(normalizedRoot, normalizedTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveCodexImageConfig(cwd: string): CodexImageConfig {
  const globalConfig = readConfigFile(
    join(homedir(), ".gsd", "agent", "extensions", "codex-image.json"),
  );
  const projectConfig = readConfigFile(join(cwd, ".gsd", "extensions", "codex-image.json"));
  const merged = { ...globalConfig, ...projectConfig };

  return {
    enabled: normalizeBoolean(merged.enabled, false),
    codexCommand: trimString(merged.codexCommand) || "codex",
    defaultOutputDir: trimString(merged.defaultOutputDir) || DEFAULT_OUTPUT_DIR,
    timeoutSec: normalizePositiveInt(merged.timeoutSec, DEFAULT_TIMEOUT_SEC),
  };
}

export function resolveDefaultOutputDir(cwd: string, config: Pick<CodexImageConfig, "defaultOutputDir">): string {
  const candidate = trimString(config.defaultOutputDir) || DEFAULT_OUTPUT_DIR;
  const absolute = resolve(cwd, candidate);
  if (!isPathInside(cwd, absolute)) {
    throw new Error(
      `codex-image defaultOutputDir must stay inside the project root: ${candidate}`,
    );
  }
  return absolute;
}

function slugifyPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "image";
}

function timestampForFileName(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export function resolveCodexImageOutputPath(input: {
  cwd: string;
  prompt: string;
  outputPath?: string;
  config: Pick<CodexImageConfig, "defaultOutputDir">;
  now?: Date;
}): string {
  const defaultOutputDir = resolveDefaultOutputDir(input.cwd, input.config);
  if (!input.outputPath) {
    return join(
      defaultOutputDir,
      `${timestampForFileName(input.now)}-${slugifyPrompt(input.prompt)}.png`,
    );
  }

  const raw = trimString(input.outputPath);
  if (!raw) {
    throw new Error("outputPath cannot be empty when provided");
  }
  if (isAbsolute(raw)) {
    throw new Error("outputPath must be project-relative");
  }

  const resolvedPath = resolve(input.cwd, raw);
  if (!isPathInside(input.cwd, resolvedPath)) {
    throw new Error("outputPath must stay inside the project root");
  }

  return extname(resolvedPath) ? resolvedPath : `${resolvedPath}.png`;
}

export function buildCodexImageOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["saved_path", "mime_type", "notes"],
    properties: {
      saved_path: { type: "string", minLength: 1 },
      mime_type: { type: "string", minLength: 1 },
      notes: { type: "string" },
    },
  };
}

export function buildCodexImageExecPrompt(input: {
  prompt: string;
  aspectRatio?: ToolParams["aspectRatio"];
  outputPath: string;
}): string {
  const extension = extname(input.outputPath).toLowerCase() || ".png";
  const formatInstruction = extension === ".jpg" || extension === ".jpeg" ? "JPEG" : extension === ".webp" ? "WEBP" : "PNG";

  return [
    `Use the installed skill "${SKILL_NAME}" for this task.`,
    "Do not inspect the workspace, run shell discovery commands, or browse files.",
    "Use native image generation immediately.",
    "Generate exactly one original raster image.",
    `Save it to this exact absolute path: ${input.outputPath}`,
    `Use ${formatInstruction} output so the saved file matches the requested path.`,
    `Aspect ratio: ${input.aspectRatio ?? "1:1"}`,
    "Do not create any extra files, variants, thumbnails, or notes outside the final JSON.",
    "If native image generation is unavailable in this Codex session, return JSON immediately saying so instead of exploring the environment.",
    "The image request is:",
    input.prompt,
  ].join("\n");
}

export function buildCodexImageExecArgs(input: {
  jobDir: string;
  schemaPath: string;
  manifestPath: string;
  writableDir: string;
  prompt: string;
  model?: string;
}): string[] {
  return [
    "exec",
    "-C",
    input.jobDir,
    "--skip-git-repo-check",
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.manifestPath,
    "--sandbox",
    "workspace-write",
    "--add-dir",
    input.writableDir,
    "--model",
    input.model ?? DEFAULT_MODEL,
    "--json",
    input.prompt,
  ];
}

function resolveAgentDir(): string {
  return trimString(process.env.GSD_AGENT_DIR) || join(homedir(), ".gsd", "agent");
}

function resolvePackageRoot(): string {
  const explicit = trimString(process.env.GSD_PACKAGE_ROOT);
  if (explicit) return explicit;
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

async function loadCloudPoolModule(): Promise<CloudPoolModule> {
  const packageRoot = resolvePackageRoot();
  const candidates = [
    join(packageRoot, "src", "cloud-pool.ts"),
    join(packageRoot, "dist", "cloud-pool.js"),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const module = await import(pathToFileURL(candidate).href);
    return module as CloudPoolModule;
  }

  throw new Error("codex-image could not locate GSD cloud-pool module");
}

function copyBundledSkill(codexHomeDir: string): void {
  const agentSkillDir = join(resolveAgentDir(), "skills", SKILL_NAME);
  const packageSkillDir = join(resolvePackageRoot(), "src", "resources", "skills", SKILL_NAME);
  const source = existsSync(agentSkillDir) ? agentSkillDir : packageSkillDir;
  if (!existsSync(source)) {
    throw new Error(`codex-image skill not found at ${source}`);
  }

  const destination = join(codexHomeDir, "skills", SKILL_NAME);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}

function maskLeaseId(leaseId: string | null | undefined): string {
  const trimmed = trimString(leaseId);
  if (!trimmed) return "n/a";
  if (trimmed.length <= 10) return trimmed;
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

function inferMimeType(filePath: string, manifestMimeType: string): string {
  const normalized = trimString(manifestMimeType).toLowerCase();
  if (normalized.startsWith("image/")) return normalized;

  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

function parseManifest(raw: string): CodexImageManifest {
  const parsed = JSON.parse(raw) as Partial<CodexImageManifest>;
  const savedPath = trimString(parsed.saved_path);
  const mimeType = trimString(parsed.mime_type);
  const notes = trimString(parsed.notes);

  if (!savedPath || !mimeType) {
    throw new Error("codex-image manifest is missing saved_path or mime_type");
  }

  return {
    saved_path: savedPath,
    mime_type: mimeType,
    notes,
  };
}

function truncateForPoolMessage(message: string): string {
  const trimmed = trimString(message).replace(/\s+/g, " ");
  return trimmed.length <= 500 ? trimmed : `${trimmed.slice(0, 497)}...`;
}

function isUnavailableImageGenerationNote(notes: string): boolean {
  const normalized = trimString(notes).toLowerCase();
  return normalized.includes("image generation is unavailable");
}

function buildRunPaths(input: {
  cwd: string;
  prompt: string;
  outputPath?: string;
  config: CodexImageConfig;
  now?: Date;
}): CodexImageRunPaths {
  const outputPath = resolveCodexImageOutputPath(input);
  const defaultOutputDir = resolveDefaultOutputDir(input.cwd, input.config);
  const outputDir = dirname(outputPath);
  const runsDir = join(defaultOutputDir, "_runs");
  const runId = `${timestampForFileName(input.now)}-${randomUUID().slice(0, 8)}`;

  return {
    outputPath,
    outputDir,
    defaultOutputDir,
    runsDir,
    runLogPath: join(runsDir, `${runId}.jsonl`),
    stderrLogPath: join(runsDir, `${runId}.stderr.log`),
  };
}

function buildAttemptPaths(cwd: string, jobId: string, attemptNumber: number): AttemptPaths {
  const rootDir = join(cwd, ".gsd", "tmp", "codex-image", `${jobId}-attempt-${attemptNumber}`);
  return {
    rootDir,
    codexHomeDir: join(rootDir, "codex-home"),
    jobDir: join(rootDir, "workspace"),
    schemaPath: join(rootDir, "output-schema.json"),
    manifestPath: join(rootDir, "manifest.json"),
  };
}

function ensureAttemptDirs(paths: AttemptPaths, runPaths: CodexImageRunPaths): void {
  mkdirSync(paths.codexHomeDir, { recursive: true });
  mkdirSync(paths.jobDir, { recursive: true });
  mkdirSync(runPaths.outputDir, { recursive: true });
  mkdirSync(runPaths.runsDir, { recursive: true });
  writeFileSync(paths.schemaPath, JSON.stringify(buildCodexImageOutputSchema(), null, 2), "utf8");
}

async function spawnCodexExec(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  runLogPath: string;
  stderrLogPath: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<SpawnResult> {
  return await new Promise<SpawnResult>((resolveResult, rejectResult) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let aborted = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
    };

    if (input.signal) {
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout?.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutChunks.push(buffer);
      appendFileSync(input.runLogPath, buffer);
    });

    child.stderr?.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrChunks.push(buffer);
      appendFileSync(input.stderrLogPath, buffer);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      if (input.signal) input.signal.removeEventListener("abort", onAbort);
      rejectResult(error);
    });

    child.on("close", (code, signalName) => {
      clearTimeout(timeout);
      if (input.signal) input.signal.removeEventListener("abort", onAbort);
      resolveResult({
        code,
        signal: signalName,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        aborted,
      });
    });
  });
}

async function releaseIfNeeded(
  cloudPool: CloudPoolModule,
  config: CloudPoolConfig,
  leaseId: string | null,
  reason: string,
): Promise<void> {
  if (!leaseId) return;
  await cloudPool.releaseCloudPoolLease(config, leaseId, reason).catch(() => {});
}

async function completeIfNeeded(
  cloudPool: CloudPoolModule,
  config: CloudPoolConfig,
  leaseId: string | null,
  input: {
    outcome: CloudPoolCompleteOutcome;
    message?: string;
    usageLimitRetryAt?: Date | null;
  },
): Promise<boolean> {
  if (!leaseId) return false;
  try {
    await cloudPool.completeCloudPoolLease(config, leaseId, input);
    return true;
  } catch {
    return false;
  }
}

async function executeCodexImageTool(
  toolCallId: string,
  params: ToolParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  const startTime = Date.now();
  const config = resolveCodexImageConfig(ctx.cwd);
  if (!config.enabled) {
    return {
      content: [
        {
          type: "text",
          text:
            "codex-image is disabled by config. It stays off by default because the current Codex CLI lane here does not expose native image generation.",
        },
      ],
      details: {
        savedPath: null,
        leaseId: "n/a",
        retryCount: 0,
        durationMs: Date.now() - startTime,
      },
      isError: true,
    };
  }

  const cloudPool = await loadCloudPoolModule();
  const basePoolConfig = cloudPool.readCloudPoolConfig(ctx.cwd);
  if (!basePoolConfig) {
    return {
      content: [
        {
          type: "text",
          text:
            "Codex image generation is unavailable because no cloud pool is configured. " +
            "Set POOL_URL, POOL_TOKEN, and POOL_SLUG (or the GSD_CLOUD_POOL_* equivalents).",
        },
      ],
      details: {
        savedPath: null,
        leaseId: "n/a",
        retryCount: 0,
        durationMs: Date.now() - startTime,
      },
      isError: true,
    };
  }

  const runPaths = buildRunPaths({
    cwd: ctx.cwd,
    prompt: params.prompt,
    outputPath: params.outputPath,
    config,
  });
  const jobId = basename(runPaths.runLogPath, ".jsonl");

  let retryCount = 0;
  let maskedLeaseId = "n/a";
  const excludedSessionIds = [...basePoolConfig.excludedSessionIds];
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const attemptNumber = attempt + 1;
    const attemptPaths = buildAttemptPaths(ctx.cwd, jobId, attemptNumber);
    ensureAttemptDirs(attemptPaths, runPaths);

    const poolConfig: CloudPoolConfig = {
      ...basePoolConfig,
      consumerId: `${basePoolConfig.consumerId}:image:${basename(ctx.cwd)}:${toolCallId}`,
      clientInstanceId: `${basePoolConfig.clientInstanceId}-image-${jobId}-${attemptNumber}`,
      excludedSessionIds: [...excludedSessionIds],
    };

    let lease: CloudPoolAcquireResponse | null = null;
    let renewTimer: NodeJS.Timeout | null = null;
    let leaseCompleted = false;

    try {
      lease = await cloudPool.acquireCloudPoolLease(poolConfig);
      maskedLeaseId = maskLeaseId(lease.leaseId);
      const renewIntervalMs = Math.max(30_000, Math.floor(poolConfig.leaseTtlSec * 500));
      renewTimer = setInterval(() => {
        void cloudPool.renewCloudPoolLease(poolConfig, lease!.leaseId).catch(() => {});
      }, renewIntervalMs);
      renewTimer.unref?.();

      const authSnapshot = await cloudPool.fetchCloudPoolAuthSnapshotText(poolConfig, lease.leaseId);
      writeFileSync(join(attemptPaths.codexHomeDir, "auth.json"), authSnapshot, "utf8");
      copyBundledSkill(attemptPaths.codexHomeDir);

      const execPrompt = buildCodexImageExecPrompt({
        prompt: params.prompt,
        aspectRatio: params.aspectRatio,
        outputPath: runPaths.outputPath,
      });
      const execArgs = buildCodexImageExecArgs({
        jobDir: attemptPaths.jobDir,
        schemaPath: attemptPaths.schemaPath,
        manifestPath: attemptPaths.manifestPath,
        writableDir: dirname(runPaths.outputPath),
        prompt: execPrompt,
      });

      const execResult = await spawnCodexExec({
        command: config.codexCommand,
        args: execArgs,
        env: {
          ...process.env,
          CODEX_HOME: attemptPaths.codexHomeDir,
        },
        cwd: attemptPaths.jobDir,
        runLogPath: runPaths.runLogPath,
        stderrLogPath: runPaths.stderrLogPath,
        timeoutMs: config.timeoutSec * 1_000,
        signal,
      });

      const combinedOutput = [execResult.stdout, execResult.stderr].filter(Boolean).join("\n");
      if (
        execResult.code !== 0 ||
        execResult.timedOut ||
        execResult.aborted ||
        !existsSync(attemptPaths.manifestPath)
      ) {
        const usageSignal = cloudPool.parseUsageLimitSignal(combinedOutput);
        if (usageSignal && attempt === 0) {
          leaseCompleted = await completeIfNeeded(cloudPool, poolConfig, lease.leaseId, {
            outcome: "usage_limited",
            message: usageSignal.message,
            usageLimitRetryAt: usageSignal.retryAt,
          });
          if (lease.sessionId) excludedSessionIds.push(lease.sessionId);
          retryCount += 1;
          rmSync(runPaths.outputPath, { force: true });
          continue;
        }

        const outcome: CloudPoolCompleteOutcome =
          execResult.aborted ? "cancelled" : execResult.timedOut ? "timed_out" : "failed";
        leaseCompleted = await completeIfNeeded(cloudPool, poolConfig, lease.leaseId, {
          outcome,
          message: truncateForPoolMessage(
            combinedOutput || `codex exited with code ${execResult.code ?? "unknown"}`,
          ),
        });

        throw new Error(
          execResult.timedOut
            ? `codex image generation timed out after ${config.timeoutSec}s`
            : combinedOutput || `codex exited with code ${execResult.code ?? "unknown"}`,
        );
      }

      const manifest = parseManifest(readFileSync(attemptPaths.manifestPath, "utf8"));
      if (resolve(manifest.saved_path) !== resolve(runPaths.outputPath)) {
        throw new Error(
          `codex-image manifest saved_path mismatch: expected ${runPaths.outputPath}, got ${manifest.saved_path}`,
        );
      }
      if (!existsSync(runPaths.outputPath) && isUnavailableImageGenerationNote(manifest.notes)) {
        leaseCompleted = await completeIfNeeded(cloudPool, poolConfig, lease.leaseId, {
          outcome: "failed",
          message: truncateForPoolMessage(manifest.notes),
        });
        return {
          content: [
            {
              type: "text",
              text:
                "Codex image generation is unavailable in the current Codex session.\n" +
                `Reason: ${manifest.notes}`,
            },
          ],
          details: {
            savedPath: null,
            leaseId: maskedLeaseId,
            retryCount,
            durationMs: Date.now() - startTime,
            notes: manifest.notes,
            source: "codex-pool",
            error: manifest.notes,
          },
          isError: true,
        };
      }
      const stat = statSync(runPaths.outputPath);
      if (!stat.isFile()) {
        throw new Error(`generated output is not a file: ${runPaths.outputPath}`);
      }

      leaseCompleted = await completeIfNeeded(cloudPool, poolConfig, lease.leaseId, {
        outcome: "succeeded",
        message: truncateForPoolMessage(manifest.notes),
      });

      const mimeType = inferMimeType(runPaths.outputPath, manifest.mime_type);
      const imageData = readFileSync(runPaths.outputPath).toString("base64");
      return {
        content: [
          {
            type: "text",
            text: [
              "Generated image via Codex pool.",
              `Saved: ${runPaths.outputPath}`,
              `Source: codex-pool`,
              manifest.notes ? `Notes: ${manifest.notes}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
          { type: "image", data: imageData, mimeType },
        ],
        details: {
          savedPath: runPaths.outputPath,
          leaseId: maskedLeaseId,
          retryCount,
          durationMs: Date.now() - startTime,
          notes: manifest.notes,
          source: "codex-pool",
        },
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lease && !leaseCompleted) {
        await completeIfNeeded(cloudPool, poolConfig, lease.leaseId, {
          outcome: signal?.aborted ? "cancelled" : "failed",
          message: truncateForPoolMessage(lastError.message),
        });
      }
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      if (lease && !leaseCompleted) {
        await releaseIfNeeded(cloudPool, poolConfig, lease.leaseId, "codex_image_exit");
      }
      rmSync(attemptPaths.rootDir, { recursive: true, force: true });
    }

    if (lastError) break;
  }

  return {
    content: [
      {
        type: "text",
        text:
          "Codex image generation failed without falling back to any external API.\n" +
          `Reason: ${lastError?.message ?? "unknown error"}`,
      },
    ],
    details: {
      savedPath: null,
      leaseId: maskedLeaseId,
      retryCount,
      durationMs: Date.now() - startTime,
      source: "codex-pool",
      error: lastError?.message ?? "unknown error",
    },
    isError: true,
  };
}

export default function registerCodexImageExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description:
      "Generate one original raster image by launching a local Codex sidecar authenticated through the configured GSD cloud pool. " +
      "Use this only when a task genuinely needs a creative visual asset saved into the project.",
    promptSnippet:
      "Generate one original image asset through Codex + the configured cloud pool, saving it into the project.",
    promptGuidelines: [
      "Use codex_generate_image only for original visual assets such as backgrounds, covers, concept art, slides, or experience illustrations.",
      "Do not use codex_generate_image for diagrams, logos, screenshots, simple SVGs, or anything better created directly in code.",
      "Pass a precise art direction in prompt and an aspectRatio when layout matters.",
      "If you need the asset on disk, prefer the default .gsd/generated-images output unless the task clearly needs a specific project-relative path.",
    ],
    parameters: TOOL_PARAMS,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      return await executeCodexImageTool(toolCallId, params, signal, ctx);
    },
  });
}
