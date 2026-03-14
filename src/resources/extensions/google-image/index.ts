import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";

const TOOL_NAME = "google_generate_image";
const TOOL_LABEL = "Google Generate Image";
const DEFAULT_OUTPUT_DIR = ".gsd/generated-images";
const DEFAULT_TIMEOUT_SEC = 120;
const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
const ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "21:9",
  "4:1",
  "1:4",
  "8:1",
  "1:8",
] as const;
const IMAGE_SIZES = ["512px", "1K", "2K", "4K"] as const;
const EXACT_TEXT_PATTERN = /["“][^"”]{2,}["”]/;
const UI_HINT_PATTERN =
  /\b(ui|ux|interface|screen|app|dashboard|hud|wireframe|landing page|menu|home screen|game screen|mobile game|infographic|diagram|map|floor plan|blueprint|callout|label|typography)\b/i;
const SPATIAL_COMPLEXITY_PATTERN =
  /\b(top[- ]left|top[- ]right|bottom[- ]left|bottom[- ]right|left side|right side|split screen|multi[- ]panel|storyboard|grid|layout|exact text|verbatim|stacked|compare|before and after)\b/i;
const PERSON_SUBJECT_PATTERN =
  /\b(face|portrait|headshot|selfie|celebrity|actor|actress|model|person|people|man|woman|boy|girl|human)\b/i;
const GROUNDING_INTENT_PATTERN =
  /\b(real[- ]world|grounded|grounding|factual|factually|accurate|reference|reference photo|specific (?:landmark|species|location)|recognizable|true[- ]to[- ]life)\b/i;
const REAL_WORLD_SUBJECT_PATTERN =
  /\b(landmark|species|subspecies|breed|genus|bird|flower|plant|animal|museum|cathedral|stadium|temple|tower|bridge|castle|palace|monument|street scene|skyline|national park|city of|inside the|outside the)\b/i;

const TOOL_PARAMS = Type.Object({
  prompt: Type.String({
    description: "Describe the original visual asset to generate.",
    minLength: 3,
  }),
  aspectRatio: Type.Optional(StringEnum(ASPECT_RATIOS)),
  imageSize: Type.Optional(StringEnum(IMAGE_SIZES)),
  outputPath: Type.Optional(
    Type.String({
      description:
        "Optional project-relative output path. Defaults to .gsd/generated-images/<timestamp>-<slug>.png",
    }),
  ),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

export interface GoogleImageConfig {
  enabled: boolean;
  model: string;
  defaultOutputDir: string;
  timeoutSec: number;
}

interface GoogleImageDetails {
  savedPath: string | null;
  model: string;
  durationMs: number;
  aspectRatio: ToolParams["aspectRatio"] | null;
  imageSize: ToolParams["imageSize"] | null;
  thinkingLevel: "minimal" | "high";
  usedSearchGrounding: boolean;
  groundingMode: "image" | "web" | null;
  error?: string;
}

type GoogleImageClient = {
  models: {
    generateContent: (args: {
      model: string;
      contents: string;
      config?: {
        abortSignal?: AbortSignal;
        responseModalities?: string[];
        tools?: Array<{
          googleSearch: Record<string, never> | { searchTypes?: { webSearch?: Record<string, never>; imageSearch?: Record<string, never> } };
        }>;
        thinkingConfig?: {
          thinkingLevel?: "minimal" | "high";
        };
        imageConfig?: {
          aspectRatio?: string;
          numberOfImages?: number;
          imageSize?: string;
          outputMimeType?: string;
        };
      };
    }) => Promise<any>;
  };
};

let client: GoogleImageClient | null = null;
let testClient: GoogleImageClient | null = null;

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readConfigFile(path: string): Partial<GoogleImageConfig> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GoogleImageConfig>;
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

export function resolveGoogleImageConfig(cwd: string): GoogleImageConfig {
  const globalConfig = readConfigFile(
    join(homedir(), ".gsd", "agent", "extensions", "google-image.json"),
  );
  const projectConfig = readConfigFile(join(cwd, ".gsd", "extensions", "google-image.json"));
  const merged = { ...globalConfig, ...projectConfig };

  return {
    enabled: normalizeBoolean(merged.enabled, true),
    model: trimString(process.env.GEMINI_IMAGE_MODEL) || trimString(merged.model) || DEFAULT_MODEL,
    defaultOutputDir: trimString(merged.defaultOutputDir) || DEFAULT_OUTPUT_DIR,
    timeoutSec: normalizePositiveInt(merged.timeoutSec, DEFAULT_TIMEOUT_SEC),
  };
}

function resolveDefaultOutputDir(cwd: string, config: Pick<GoogleImageConfig, "defaultOutputDir">): string {
  const candidate = trimString(config.defaultOutputDir) || DEFAULT_OUTPUT_DIR;
  const absolute = resolve(cwd, candidate);
  if (!isPathInside(cwd, absolute)) {
    throw new Error(`google-image defaultOutputDir must stay inside the project root: ${candidate}`);
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

export function resolveGoogleImageOutputPath(input: {
  cwd: string;
  prompt: string;
  outputPath?: string;
  config: Pick<GoogleImageConfig, "defaultOutputDir">;
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
  if (!raw) throw new Error("outputPath cannot be empty when provided");
  if (isAbsolute(raw)) throw new Error("outputPath must be project-relative");

  const resolvedPath = resolve(input.cwd, raw);
  if (!isPathInside(input.cwd, resolvedPath)) {
    throw new Error("outputPath must stay inside the project root");
  }

  return extname(resolvedPath) ? resolvedPath : `${resolvedPath}.png`;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function getGeminiApiKey(): string {
  return trimString(process.env.GEMINI_API_KEY);
}

async function getClient(): Promise<GoogleImageClient> {
  if (testClient) return testClient;
  if (!client) {
    const { GoogleGenAI } = await import("@google/genai");
    client = new GoogleGenAI({ apiKey: getGeminiApiKey() });
  }
  return client;
}

export function setGoogleImageClientForTests(value: GoogleImageClient | null): void {
  testClient = value;
  client = null;
}

export interface GoogleImageStrategy {
  thinkingLevel: "minimal" | "high";
  usedSearchGrounding: boolean;
  groundingMode: "image" | "web" | null;
  looksLikeInterface: boolean;
  requiresExactText: boolean;
}

export function resolveGoogleImageStrategy(prompt: string): GoogleImageStrategy {
  const text = prompt.trim();
  const looksLikeInterface = UI_HINT_PATTERN.test(text);
  const requiresExactText = EXACT_TEXT_PATTERN.test(text) || /\b(exact text|verbatim|headline|copy|caption)\b/i.test(text);
  const mentionsPeople = PERSON_SUBJECT_PATTERN.test(text);
  const explicitGroundingIntent = GROUNDING_INTENT_PATTERN.test(text);
  const realWorldSubject = REAL_WORLD_SUBJECT_PATTERN.test(text);
  const usedSearchGrounding = !mentionsPeople && (explicitGroundingIntent || realWorldSubject);
  const groundingMode =
    usedSearchGrounding ? (looksLikeInterface || requiresExactText ? "web" : "image") : null;
  const thinkingLevel =
    looksLikeInterface || requiresExactText || SPATIAL_COMPLEXITY_PATTERN.test(text)
      ? "high"
      : "minimal";

  return {
    thinkingLevel,
    usedSearchGrounding,
    groundingMode,
    looksLikeInterface,
    requiresExactText,
  };
}

export function buildGoogleImagePrompt(prompt: string, strategy: GoogleImageStrategy): string {
  const instructions = [
    "Create exactly one original raster image.",
    "Treat the result as a production-ready asset, not a rough sketch, unless the prompt explicitly asks for a sketch or concept sheet.",
    strategy.thinkingLevel === "high"
      ? "Reason carefully about composition, spatial relationships, and requested typography before rendering."
      : "Keep reasoning light and direct; favor speed unless the prompt clearly needs extra deliberation.",
    strategy.groundingMode === "image"
      ? "Use Google Search grounding to preserve recognizable real-world visual details."
      : strategy.groundingMode === "web"
        ? "Use Google Search grounding to preserve real-world textual and factual details."
        : "Do not add external factual baggage beyond what the prompt actually asks for.",
    strategy.looksLikeInterface
      ? "Render one coherent full-screen interface or game screen. Avoid collages, multi-screen sheets, or split layouts unless the prompt explicitly asks for them."
      : "",
    strategy.requiresExactText
      ? "Honor any quoted or explicitly requested on-image text verbatim and keep it legible."
      : "If the prompt does not require text, avoid adding random labels, logos, or watermarks.",
    "Return the image and, if useful, one short text note.",
    prompt.trim(),
  ].filter(Boolean);

  return instructions.join("\n\n");
}

function resolveSearchTool(strategy: GoogleImageStrategy):
  | Array<{ googleSearch: Record<string, never> | { searchTypes?: { webSearch?: Record<string, never>; imageSearch?: Record<string, never> } } }>
  | undefined {
  if (strategy.groundingMode === "web") {
    return [{ googleSearch: { searchTypes: { webSearch: {} } } }];
  }
  if (strategy.groundingMode === "image") {
    return [{ googleSearch: { searchTypes: { imageSearch: {} } } }];
  }
  return undefined;
}

function classifyError(message: string): string {
  if (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("UNAUTHENTICATED") ||
    message.includes("PERMISSION_DENIED")
  ) {
    return "auth_error";
  }
  if (
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.toLowerCase().includes("quota")
  ) {
    return "rate_limit";
  }
  if (message.toLowerCase().includes("abort") || message.toLowerCase().includes("timeout")) {
    return "timeout";
  }
  return "api_error";
}

function extractImageResponse(response: any): {
  imageBase64: string;
  mimeType: string;
  notes: string;
} {
  const parts = response?.candidates
    ?.flatMap((candidate: any) => candidate?.content?.parts ?? []) ?? [];
  const imagePart = parts.find(
    (part: any) => part?.inlineData?.data && String(part?.inlineData?.mimeType ?? "").startsWith("image/"),
  );
  const notes = parts
    .map((part: any) => trimString(part?.text))
    .filter(Boolean)
    .join("\n")
    .trim() || trimString(response?.text);

  if (!imagePart?.inlineData?.data) {
    throw new Error(notes || "Google image model returned no image data.");
  }

  return {
    imageBase64: imagePart.inlineData.data,
    mimeType: trimString(imagePart.inlineData.mimeType) || "image/png",
    notes,
  };
}

async function executeGoogleImageTool(
  params: ToolParams,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  const startTime = Date.now();
  const config = resolveGoogleImageConfig(ctx.cwd);
  const strategy = resolveGoogleImageStrategy(params.prompt);
  if (!config.enabled) {
    return {
      content: [{ type: "text", text: "google-image is disabled by config." }],
      isError: true,
      details: {
        savedPath: null,
        model: config.model,
        durationMs: Date.now() - startTime,
        aspectRatio: params.aspectRatio ?? null,
        imageSize: params.imageSize ?? null,
        thinkingLevel: strategy.thinkingLevel,
        usedSearchGrounding: strategy.usedSearchGrounding,
        groundingMode: strategy.groundingMode,
      } satisfies GoogleImageDetails,
    };
  }

  if (!getGeminiApiKey()) {
    return {
      content: [
        {
          type: "text",
          text:
            "Google image generation requires GEMINI_API_KEY.\n\n" +
            "Set it in your shell or project .env before using google_generate_image.",
        },
      ],
      isError: true,
      details: {
        savedPath: null,
        model: config.model,
        durationMs: Date.now() - startTime,
        aspectRatio: params.aspectRatio ?? null,
        imageSize: params.imageSize ?? null,
        thinkingLevel: strategy.thinkingLevel,
        usedSearchGrounding: strategy.usedSearchGrounding,
        groundingMode: strategy.groundingMode,
        error: "auth_error: GEMINI_API_KEY not set",
      } satisfies GoogleImageDetails,
    };
  }

  const outputPath = resolveGoogleImageOutputPath({
    cwd: ctx.cwd,
    prompt: params.prompt,
    outputPath: params.outputPath,
    config,
  });
  mkdirSync(resolveDefaultOutputDir(ctx.cwd, config), { recursive: true });
  mkdirSync(dirname(outputPath), { recursive: true });

  const timeoutSignal = AbortSignal.timeout(config.timeoutSec * 1000);
  const requestSignal = signal ? anySignal([signal, timeoutSignal]) : timeoutSignal;

  try {
    const ai = await getClient();
    const response = await ai.models.generateContent({
      model: config.model,
      contents: buildGoogleImagePrompt(params.prompt, strategy),
      config: {
        abortSignal: requestSignal,
        responseModalities: ["TEXT", "IMAGE"],
        thinkingConfig: {
          thinkingLevel: strategy.thinkingLevel,
        },
        tools: resolveSearchTool(strategy),
        imageConfig: {
          aspectRatio: params.aspectRatio,
          numberOfImages: 1,
          imageSize: params.imageSize,
        },
      },
    });

    const image = extractImageResponse(response);
    writeFileSync(outputPath, Buffer.from(image.imageBase64, "base64"));

    return {
      content: [
        {
          type: "text",
          text: [
            "Generated image via Google Gemini API.",
            `Saved: ${outputPath}`,
            `Model: ${config.model}`,
            `Thinking: ${strategy.thinkingLevel}`,
            `Grounding: ${strategy.groundingMode ?? "off"}`,
            params.imageSize ? `Image size: ${params.imageSize}` : "",
            image.notes ? `Notes: ${image.notes}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
        { type: "image", data: image.imageBase64, mimeType: image.mimeType },
      ],
      details: {
        savedPath: outputPath,
        model: config.model,
        durationMs: Date.now() - startTime,
        aspectRatio: params.aspectRatio ?? null,
        imageSize: params.imageSize ?? null,
        thinkingLevel: strategy.thinkingLevel,
        usedSearchGrounding: strategy.usedSearchGrounding,
        groundingMode: strategy.groundingMode,
      } satisfies GoogleImageDetails,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const errorType = classifyError(message);

    return {
      content: [{ type: "text", text: `Google image generation failed (${errorType}): ${message}` }],
      isError: true,
      details: {
        savedPath: null,
        model: config.model,
        durationMs: Date.now() - startTime,
        aspectRatio: params.aspectRatio ?? null,
        imageSize: params.imageSize ?? null,
        thinkingLevel: strategy.thinkingLevel,
        usedSearchGrounding: strategy.usedSearchGrounding,
        groundingMode: strategy.groundingMode,
        error: `${errorType}: ${message}`,
      } satisfies GoogleImageDetails,
    };
  }
}

export default function registerGoogleImageExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description:
      "Generate one original raster image with Google's Gemini image model through the Gemini API. " +
      "Use this only when a task genuinely needs a creative visual asset saved into the project. Requires GEMINI_API_KEY.",
    promptSnippet:
      "Generate one original image asset through Google's Gemini image model, saving it into the project.",
    promptGuidelines: [
      "Use google_generate_image only for original visual assets such as backgrounds, covers, concept art, slides, or experience illustrations.",
      "Do not use google_generate_image for diagrams, logos, screenshots, simple SVGs, or anything better created directly in code.",
      "Pass a precise art direction in prompt and an aspectRatio when layout matters. Wide strips (4:1, 8:1) and tall strips (1:4, 1:8) are supported here.",
      "The tool keeps thinking minimal by default and only uses high thinking for UI, typography, or layout-heavy prompts.",
      "The tool can auto-enable Google Search grounding for real-world landmarks or species, but it intentionally avoids search grounding for person-centric prompts.",
      "Use imageSize=512px for fast iteration and larger sizes only when the task genuinely needs them.",
      "If you need the asset on disk, prefer the default .gsd/generated-images output unless the task clearly needs a specific project-relative path.",
    ],
    parameters: TOOL_PARAMS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return await executeGoogleImageTool(params, signal, ctx);
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("google_generate_image "));
      text += theme.fg("accent", `"${args.prompt}"`);
      if (args.aspectRatio) text += theme.fg("dim", ` (${args.aspectRatio})`);
      if (args.imageSize) text += theme.fg("dim", ` ${args.imageSize}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme) {
      const details = result.details as GoogleImageDetails | undefined;

      if (isPartial) return new Text(theme.fg("warning", "Generating image via Google..."), 0, 0);
      if (result.isError || details?.error) {
        return new Text(theme.fg("error", `Error: ${details?.error ?? "unknown"}`), 0, 0);
      }

      let text = theme.fg("success", "saved");
      if (details?.savedPath) text += theme.fg("dim", ` ${details.savedPath}`);
      text += theme.fg("dim", ` (${details?.durationMs ?? 0}ms)`);
      if (expanded && result.content[0]?.type === "text") {
        text += "\n\n" + theme.fg("dim", result.content[0].text);
      }

      return new Text(text, 0, 0);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const config = resolveGoogleImageConfig(ctx.cwd);
    if (config.enabled && !getGeminiApiKey()) {
      ctx.ui.notify(
        "Google Image: No GEMINI_API_KEY set. The google_generate_image tool will not work until this is configured.",
        "warning",
      );
    }
  });
}
