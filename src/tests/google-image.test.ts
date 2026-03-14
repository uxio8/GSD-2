import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import registerGoogleImageExtension, {
  buildGoogleImagePrompt,
  resolveGoogleImageConfig,
  resolveGoogleImageOutputPath,
  resolveGoogleImageStrategy,
  setGoogleImageClientForTests,
} from "../resources/extensions/google-image/index.ts";

function makeStubTool() {
  let registered: any = null;
  registerGoogleImageExtension({
    registerTool(definition: unknown) {
      registered = definition;
    },
    on() {},
  } as any);
  return registered;
}

test("google-image config merges global defaults with project overrides", () => {
  const home = mkdtempSync(join(tmpdir(), "gsd-google-image-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "gsd-google-image-cwd-"));
  const originalHome = process.env.HOME;
  const originalModel = process.env.GEMINI_IMAGE_MODEL;

  try {
    process.env.HOME = home;
    delete process.env.GEMINI_IMAGE_MODEL;
    mkdirSync(join(home, ".gsd", "agent", "extensions"), { recursive: true });
    mkdirSync(join(cwd, ".gsd", "extensions"), { recursive: true });

    writeFileSync(
      join(home, ".gsd", "agent", "extensions", "google-image.json"),
      JSON.stringify({
        enabled: false,
        model: "global-model",
        defaultOutputDir: ".gsd/global-images",
        timeoutSec: 321,
      }),
      "utf8",
    );
    writeFileSync(
      join(cwd, ".gsd", "extensions", "google-image.json"),
      JSON.stringify({
        enabled: true,
        timeoutSec: 222,
      }),
      "utf8",
    );

    const config = resolveGoogleImageConfig(cwd);
    assert.deepEqual(config, {
      enabled: true,
      model: "global-model",
      defaultOutputDir: ".gsd/global-images",
      timeoutSec: 222,
    });
  } finally {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalModel) process.env.GEMINI_IMAGE_MODEL = originalModel;
    else delete process.env.GEMINI_IMAGE_MODEL;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("google-image output path stays inside project and defaults to png names", () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-google-image-paths-"));

  try {
    const config = { defaultOutputDir: ".gsd/generated-images" };
    const generated = resolveGoogleImageOutputPath({
      cwd,
      prompt: "Moonlit Escape Title Card",
      config,
      now: new Date("2026-03-14T12:34:56.000Z"),
    });
    assert.equal(
      generated,
      join(
        cwd,
        ".gsd",
        "generated-images",
        "2026-03-14T12-34-56-000Z-moonlit-escape-title-card.png",
      ),
    );

    const explicit = resolveGoogleImageOutputPath({
      cwd,
      prompt: "ignored",
      outputPath: "assets/covers/hero",
      config,
    });
    assert.equal(explicit, join(cwd, "assets", "covers", "hero.png"));

    assert.throws(
      () =>
        resolveGoogleImageOutputPath({
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

test("google-image registers an LLM-callable tool with guardrails", () => {
  const tool = makeStubTool();
  assert.equal(tool.name, "google_generate_image");
  assert.equal(tool.label, "Google Generate Image");
  assert.equal(typeof tool.execute, "function");
  assert.ok(Array.isArray(tool.promptGuidelines));
  assert.ok(tool.promptGuidelines.some((line: string) => line.includes("diagrams")));
  assert.ok(tool.promptGuidelines.some((line: string) => line.includes("imageSize=512px")));
});

test("google-image strategy keeps people prompts ungrounded and promotes complex UI prompts to high thinking", () => {
  const portrait = resolveGoogleImageStrategy("A photoreal portrait of a smiling woman in warm light.");
  assert.equal(portrait.usedSearchGrounding, false);
  assert.equal(portrait.groundingMode, null);
  assert.equal(portrait.thinkingLevel, "minimal");

  const ui = resolveGoogleImageStrategy(
    'A mobile game home screen for a cyber escape room app with the exact text "Continue Mission".',
  );
  assert.equal(ui.usedSearchGrounding, false);
  assert.equal(ui.looksLikeInterface, true);
  assert.equal(ui.thinkingLevel, "high");

  const landmark = resolveGoogleImageStrategy(
    "A grounded poster of the Eiffel Tower at sunset with realistic structural details.",
  );
  assert.equal(landmark.usedSearchGrounding, true);
  assert.equal(landmark.groundingMode, "image");
});

test("google-image prompt builder injects Nano Banana style guardrails without bloating the user prompt", () => {
  const strategy = resolveGoogleImageStrategy(
    'A vertical mobile game screen with the exact text "Find the Key".',
  );
  const built = buildGoogleImagePrompt(
    'A vertical mobile game screen with the exact text "Find the Key".',
    strategy,
  );

  assert.match(built, /Create exactly one original raster image\./);
  assert.match(built, /Reason carefully about composition, spatial relationships, and requested typography/);
  assert.match(built, /Render one coherent full-screen interface or game screen/);
  assert.match(built, /Honor any quoted or explicitly requested on-image text verbatim/);
  assert.match(built, /Find the Key/);
});

test("google-image returns a clear auth error when GEMINI_API_KEY is missing", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-google-image-no-key-"));
  const originalKey = process.env.GEMINI_API_KEY;

  try {
    delete process.env.GEMINI_API_KEY;
    const tool = makeStubTool();
    const result = await tool.execute(
      "tool-call-no-key",
      { prompt: "A premium escape room cover." },
      undefined,
      undefined,
      { cwd } as any,
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /GEMINI_API_KEY/i);
  } finally {
    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("google-image saves the generated image and returns it inline", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-google-image-success-"));
  const originalKey = process.env.GEMINI_API_KEY;

  try {
    process.env.GEMINI_API_KEY = "test-key";
    setGoogleImageClientForTests({
      models: {
        async generateContent(args) {
          assert.equal(args.model, "gemini-3.1-flash-image-preview");
          assert.deepEqual(args.config?.responseModalities, ["TEXT", "IMAGE"]);
          assert.equal(args.config?.imageConfig?.numberOfImages, 1);
          assert.equal(args.config?.imageConfig?.aspectRatio, "1:8");
          assert.equal(args.config?.imageConfig?.imageSize, "512px");
          assert.deepEqual(args.config?.thinkingConfig, { thinkingLevel: "high" });
          assert.deepEqual(args.config?.tools, [{ googleSearch: { searchTypes: { webSearch: {} } } }]);
          return {
            text: "Generated one image.",
            candidates: [
              {
                content: {
                  parts: [
                    { text: "Generated one image." },
                    {
                      inlineData: {
                        mimeType: "image/png",
                        data:
                          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2F7mQAAAAASUVORK5CYII=",
                      },
                    },
                  ],
                },
              },
            ],
          };
        },
      },
    });

    const tool = makeStubTool();
    const result = await tool.execute(
      "tool-call-success",
      {
        prompt:
          'A grounded mobile game screen for a virtual escape room museum in Paris with the exact text "Begin Escape".',
        aspectRatio: "1:8",
        imageSize: "512px",
      },
      undefined,
      undefined,
      { cwd } as any,
    );

    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, "text");
    assert.equal(result.content[1].type, "image");
    assert.match(result.content[0].text, /Generated image via Google Gemini API/i);
    assert.match(result.content[0].text, /Thinking: high/);
    assert.match(result.content[0].text, /Grounding: web/);
    assert.match(result.content[0].text, /Image size: 512px/);
    assert.ok(result.details.savedPath.endsWith(".png"));
    assert.equal(result.details.imageSize, "512px");
    assert.equal(result.details.thinkingLevel, "high");
    assert.equal(result.details.groundingMode, "web");
    assert.ok(existsSync(result.details.savedPath));
  } finally {
    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
    setGoogleImageClientForTests(null);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("google-image surfaces no-image model responses cleanly", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gsd-google-image-no-image-"));
  const originalKey = process.env.GEMINI_API_KEY;

  try {
    process.env.GEMINI_API_KEY = "test-key";
    setGoogleImageClientForTests({
      models: {
        async generateContent() {
          return {
            text: "The request was blocked.",
            candidates: [
              {
                content: {
                  parts: [{ text: "The request was blocked." }],
                },
              },
            ],
          };
        },
      },
    });

    const tool = makeStubTool();
    const result = await tool.execute(
      "tool-call-no-image",
      { prompt: "A blocked prompt." },
      undefined,
      undefined,
      { cwd } as any,
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /returned no image data|blocked/i);
  } finally {
    if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    else delete process.env.GEMINI_API_KEY;
    setGoogleImageClientForTests(null);
    rmSync(cwd, { recursive: true, force: true });
  }
});
