export interface ModelFile {
  url: string;
  sha256: string;
  bytes: number;
}

export interface ModelDescriptor {
  id: string;
  engine: string;
  lang: "en" | "ar";
  modelId: string;
  revision: string | null;
  license: string;
  verified: boolean;
  files: ModelFile[];
}

export interface ModelProgress {
  modelId: string;
  loaded: number;
  total: number;
  stage: string;
}

export interface ModelStorage {
  match(request: RequestInfo | URL): Promise<Response | undefined>;
  put(request: RequestInfo | URL, response: Response): Promise<void>;
  delete(request: RequestInfo | URL): Promise<boolean>;
}

const CACHE_NAME = "os-models-v1";
const RETRY_DELAYS_MS = [250, 750, 1_500];

export class ModelUnavailableError extends Error {
  constructor(modelId: string, detail: string) {
    super(`${modelId} is unavailable: ${detail}`);
    this.name = "ModelUnavailableError";
  }
}

function isSha256(value: string): boolean {
  return /^[a-f\d]{64}$/iu.test(value);
}

function isPinnedRevision(value: string | null): value is string {
  return value !== null && /^[a-f\d]{40}$/iu.test(value);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class ModelManager {
  readonly #models: ModelDescriptor[];
  readonly #cacheStorage: CacheStorage | undefined;
  #cache: Promise<ModelStorage> | null = null;
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(
    models: ModelDescriptor[],
    options: {
      cacheStorage?: CacheStorage;
      fetcher?: typeof fetch;
      sleep?: (milliseconds: number) => Promise<void>;
    } = {},
  ) {
    this.#models = models;
    this.#cacheStorage =
      options.cacheStorage ??
      (typeof caches === "undefined" ? undefined : caches);
    this.#fetch = options.fetcher ?? fetch.bind(globalThis);
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  list(): ModelDescriptor[] {
    return structuredClone(this.#models);
  }

  get(modelId: string): ModelDescriptor | undefined {
    return this.#models.find((model) => model.id === modelId);
  }

  canDownload(modelId: string): boolean {
    const model = this.get(modelId);
    return Boolean(
      model?.verified &&
      isPinnedRevision(model.revision) &&
      model.files.length > 0 &&
      model.files.every(
        (file) =>
          isSha256(file.sha256) &&
          Number.isSafeInteger(file.bytes) &&
          file.bytes > 0,
      ),
    );
  }

  async readFile(modelId: string, fileUrl: string): Promise<ArrayBuffer> {
    const model = this.get(modelId);
    const file = model?.files.find((candidate) => candidate.url === fileUrl);
    if (!model || !file || !this.canDownload(modelId)) {
      throw new ModelUnavailableError(
        modelId,
        "the requested file is not in a verified model manifest",
      );
    }
    const cache = await this.#getCache();
    const response = await cache.match(file.url);
    if (!response || !(await this.#responseIsValid(response.clone(), file))) {
      if (response) await cache.delete(file.url);
      throw new ModelUnavailableError(modelId, "the verified file is not cached");
    }
    return response.arrayBuffer();
  }

  createTransformersCache(): {
    match(request: RequestInfo | URL): Promise<Response | undefined>;
    put(request: RequestInfo | URL, response: Response): Promise<void>;
  } {
    return {
      match: async (request) => {
        const file = this.#fileForRequest(request);
        if (!file) return undefined;
        const cache = await this.#getCache();
        const response = await cache.match(file.url);
        if (!response) return undefined;
        if (!(await this.#responseIsValid(response.clone(), file))) {
          await cache.delete(file.url);
          return undefined;
        }
        return response;
      },
      put: async (request, response) => {
        const file = this.#fileForRequest(request);
        if (!file) {
          throw new Error("Transformers.js requested an unlisted model file.");
        }
        const bytes = await response.arrayBuffer();
        if (
          bytes.byteLength !== file.bytes ||
          (await sha256(bytes)).toLowerCase() !== file.sha256.toLowerCase()
        ) {
          throw new Error(`SHA-256 mismatch for ${file.url}`);
        }
        const cache = await this.#getCache();
        await cache.put(
          file.url,
          new Response(bytes, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
          }),
        );
      },
    };
  }

  async isInstalled(modelId: string): Promise<boolean> {
    const model = this.get(modelId);
    if (!model || !this.canDownload(modelId)) return false;
    const cache = await this.#getCache();
    const matches = await Promise.all(
      model.files.map(async (file) => {
        const response = await cache.match(file.url);
        return response ? this.#responseIsValid(response, file) : false;
      }),
    );
    return matches.every(Boolean);
  }

  async download(
    modelId: string,
    onProgress?: (progress: ModelProgress) => void,
  ): Promise<void> {
    const model = this.get(modelId);
    if (!model || !this.canDownload(modelId)) {
      throw new ModelUnavailableError(
        modelId,
        "a pinned revision and verified SHA-256 manifest are required",
      );
    }

    const cache = await this.#getCache();
    let loaded = 0;
    const total = model.files.reduce((sum, file) => sum + file.bytes, 0);

    for (const file of model.files) {
      const cached = await cache.match(file.url);
      if (cached && (await this.#responseIsValid(cached, file))) {
        loaded += file.bytes;
        onProgress?.({ modelId, loaded, total, stage: "ready" });
        continue;
      }
      if (cached) await cache.delete(file.url);

      const response = await this.#fetchWithRetry(file, (fileLoaded) => {
        onProgress?.({
          modelId,
          loaded: loaded + fileLoaded,
          total,
          stage: "downloading",
        });
      });
      const bytes = await response.arrayBuffer();
      const digest = await sha256(bytes);
      if (digest.toLowerCase() !== file.sha256.toLowerCase()) {
        await cache.delete(file.url);
        throw new Error(`SHA-256 mismatch for ${file.url}`);
      }

      await cache.put(
        file.url,
        new Response(bytes, {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        }),
      );
      loaded += file.bytes;
      onProgress?.({ modelId, loaded, total, stage: "verified" });
    }
  }

  async remove(modelId: string): Promise<void> {
    const model = this.get(modelId);
    if (!model) return;
    const cache = await this.#getCache();
    await Promise.all(model.files.map((file) => cache.delete(file.url)));
  }

  async #fetchWithRetry(
    file: ModelFile,
    onProgress: (loaded: number) => void,
  ): Promise<Response> {
    let lastError: unknown;
    let partialChunks: Uint8Array[] = [];
    let partialBytes = 0;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await this.#fetch(
          file.url,
          partialBytes > 0
            ? { headers: { Range: `bytes=${partialBytes}-` } }
            : undefined,
        );
        if (!response.ok && response.status !== 206) {
          throw new Error(`Model request failed with HTTP ${response.status}`);
        }
        if (response.status === 206 && partialBytes > 0) {
          const range = response.headers.get("content-range");
          if (!range?.startsWith(`bytes ${partialBytes}-`)) {
            throw new Error("Model server returned an invalid byte range");
          }
        } else if (partialBytes > 0) {
          partialChunks = [];
          partialBytes = 0;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          partialChunks.push(bytes);
          partialBytes += bytes.byteLength;
          onProgress(partialBytes);
        } else {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            partialChunks.push(value);
            partialBytes += value.byteLength;
            onProgress(partialBytes);
            if (partialBytes > file.bytes) {
              throw new Error(
                `Model file exceeds its declared size: ${file.url}`,
              );
            }
          }
        }
        if (partialBytes !== file.bytes) {
          throw new Error(
            `Model size mismatch for ${file.url}: expected ${file.bytes}, received ${partialBytes}`,
          );
        }

        const bytes = new Uint8Array(partialBytes);
        let offset = 0;
        for (const chunk of partialChunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return new Response(bytes, {
          headers: response.headers,
        });
      } catch (error) {
        lastError = error;
        if (attempt + 1 < RETRY_DELAYS_MS.length) {
          if (partialBytes >= file.bytes) {
            partialChunks = [];
            partialBytes = 0;
          }
          await this.#sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Model download failed");
  }

  async #responseIsValid(
    response: Response,
    file: ModelFile,
  ): Promise<boolean> {
    const bytes = await response.arrayBuffer();
    return (
      bytes.byteLength === file.bytes &&
      (await sha256(bytes)).toLowerCase() === file.sha256.toLowerCase()
    );
  }

  #fileForRequest(request: RequestInfo | URL): ModelFile | undefined {
    const requestUrl =
      typeof request === "string"
        ? request
        : request instanceof Request
          ? request.url
          : request.toString();
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(requestUrl).pathname);
    } catch {
      return undefined;
    }

    for (const model of this.#models) {
      const prefix = `/${model.modelId}/resolve/`;
      if (!pathname.startsWith(prefix)) continue;
      const resolvedPath = pathname.slice(prefix.length);
      const revisionEnd = resolvedPath.indexOf("/");
      if (revisionEnd < 0) continue;
      const relativePath = resolvedPath.slice(revisionEnd + 1);
      const file = model.files.find((candidate) => {
        const candidatePath = new URL(candidate.url).pathname;
        return candidatePath.endsWith(
          `${prefix}${model.revision}/${relativePath}`,
        );
      });
      if (file) return file;
    }
    return undefined;
  }

  async #getCache(): Promise<ModelStorage> {
    if (!this.#cacheStorage) {
      throw new Error(
        "The Cache Storage API is not available in this context.",
      );
    }
    this.#cache ??= this.#cacheStorage.open(CACHE_NAME);
    return this.#cache;
  }
}
