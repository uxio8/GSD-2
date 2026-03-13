import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "blob-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("BlobStore externalizes and resolves base64 payloads", async () => {
  const { BlobStore, externalizeImageData, resolveImageData, parseBlobRef } = await import("@mariozechner/pi-coding-agent") as any;
  const { dir, cleanup } = makeTmpDir();
  try {
    const store = new BlobStore(join(dir, "blobs"));
    const base64 = Buffer.from("round trip test").toString("base64");
    const ref = externalizeImageData(store, base64);
    assert.ok(ref.startsWith("blob:sha256:"));
    assert.ok(store.has(parseBlobRef(ref)));
    assert.equal(resolveImageData(store, ref), base64);
  } finally {
    cleanup();
  }
});
