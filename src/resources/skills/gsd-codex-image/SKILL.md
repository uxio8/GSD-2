---
name: gsd-codex-image
description: Generate exactly one original raster image with Codex when a task explicitly needs a visual asset, save it to the requested path, and return only a short JSON manifest.
---

# GSD Codex Image

Use Codex's built-in image capability to create exactly one original image for the current task.

## Rules

- Start image generation immediately. Do not inspect the workspace, run discovery commands, or browse files unless the caller explicitly asks.
- Generate exactly one image.
- Save it to the exact absolute output path provided in the prompt.
- Prefer PNG unless the prompt explicitly requires a different raster format.
- Do not create variants, alternates, thumbnails, or extra files.
- Do not modify any source files or project files other than the requested image path.
- If the requested aspect ratio is provided, follow it exactly.
- If native image generation is unavailable in the current Codex session, stop immediately and return JSON with the requested path, an empty or placeholder mime type, and `notes` explaining that image generation is unavailable.

## Final Response

Return only compact JSON matching the caller schema:

```json
{
  "saved_path": "/absolute/path/to/file.png",
  "mime_type": "image/png",
  "notes": "One short sentence about the generated image."
}
```

Keep `notes` short and factual.
