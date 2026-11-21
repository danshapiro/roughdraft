import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalStorageBackend } from "./local-storage-backend";

describe("LocalStorageBackend attachments", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["one.png", "two.png"],
    ["image.png", "image.png"],
  ])("preserves concurrent attachments named %s and %s", async (first, second) => {
    const backend = new LocalStorageBackend();
    const assets = await Promise.all([
      backend.saveAsset(new File(["first"], first, { type: "image/png" })),
      backend.saveAsset(new File(["second"], second, { type: "image/png" })),
    ]);

    expect(new Set(assets.map((asset) => asset.markdownPath)).size).toBe(2);
    for (const asset of assets) {
      expect(backend.resolveFileUrl(asset.markdownPath)).toBe(asset.previewUrl);
    }
    expect(assets[0].previewUrl).not.toBe(assets[1].previewUrl);
  });
});
