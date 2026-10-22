import { describe, expect, it, vi } from "vitest";
import {
  ModelManager,
  type ModelDescriptor,
  type ModelStorage,
} from "../../src/models/manager";

const VALID_MODEL: ModelDescriptor = {
  id: "sample-model",
  engine: "test",
  lang: "en",
  modelId: "test/model",
  revision: "0123456789abcdef0123456789abcdef01234567",
  license: "Apache-2.0",
  verified: true,
  files: [
    {
      url: "https://huggingface.co/test/model/resolve/0123456789abcdef/model.bin",
      sha256:
        "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      bytes: 3,
    },
  ],
};

function makeCache() {
  const entries = new Map<string, Response>();
  const cache: ModelStorage = {
    async match(request) {
      const key = String(request);
      return entries.get(key)?.clone();
    },
    async put(request, response) {
      entries.set(String(request), response.clone());
    },
    async delete(request) {
      return entries.delete(String(request));
    },
  };
  const storage = {
    open: vi.fn(async () => cache),
  } as unknown as CacheStorage;
  return { cache, storage };
}

describe("model manager", () => {
  it("does not download a model without a pinned checksum manifest", async () => {
    const fetcher = vi.fn();
    const manager = new ModelManager(
      [
        {
          ...VALID_MODEL,
          revision: null,
          verified: false,
          files: [],
        },
      ],
      { fetcher },
    );

    expect(manager.canDownload("sample-model")).toBe(false);
    await expect(manager.download("sample-model")).rejects.toThrow(
      "pinned revision and verified SHA-256 manifest are required",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("checks a download before caching and reuses the verified response", async () => {
    const { storage } = makeCache();
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const manager = new ModelManager([VALID_MODEL], {
      cacheStorage: storage,
      fetcher,
      sleep: async () => {},
    });

    await manager.download("sample-model");
    expect(await manager.isInstalled("sample-model")).toBe(true);
    await manager.download("sample-model");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a file whose digest differs from the pinned value", async () => {
    const { storage, cache } = makeCache();
    const manager = new ModelManager([VALID_MODEL], {
      cacheStorage: storage,
      fetcher: async () => new Response(new Uint8Array([9, 8, 7])),
      sleep: async () => {},
    });

    await expect(manager.download("sample-model")).rejects.toThrow(
      "SHA-256 mismatch",
    );
    expect(await cache.match(VALID_MODEL.files[0].url)).toBeUndefined();
  });
});
