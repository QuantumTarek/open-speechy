import type { AppSettings, SettingsPatch } from "../settings/store";
import { normalizeServerUrl, ServerEngine } from "./server";

// The installer registers this native messaging host. It hands over the server
// token without a pairing code, and starts or stops the server.
export const NATIVE_HOST_NAME = "dev.openspeechy.host";

export interface HostStatus {
  running: boolean;
  version: string | null;
  canManage: boolean;
}

export interface HostConnection extends HostStatus {
  token: string;
  url: string;
}

export interface ServerState {
  enabled: boolean;
  // The native host is installed for this browser and extension.
  helper: boolean;
  running: boolean;
  // Paired, and the server accepts the token.
  connected: boolean;
  canManage: boolean;
  version: string | null;
  error?: string;
}

export type SendNativeMessage = (
  host: string,
  message: Record<string, unknown>,
) => Promise<unknown>;

// Chrome rejects with these when the host is not installed for this browser,
// or not for this extension ID.
const HOST_MISSING = /not found|forbidden/iu;

export class ServerHost {
  readonly #send: SendNativeMessage;

  constructor(
    send: SendNativeMessage = (host, message) =>
      chrome.runtime.sendNativeMessage(host, message),
  ) {
    this.#send = send;
  }

  /** Null when the helper is not installed. */
  async status(): Promise<HostStatus | null> {
    const reply = await this.#request("status");
    return reply && parseStatus(reply);
  }

  async connect(): Promise<HostConnection | null> {
    const reply = await this.#request("connect");
    if (!reply) return null;
    if (typeof reply.token !== "string" || !reply.token) {
      throw new Error("The server helper returned no token.");
    }
    return {
      ...parseStatus(reply),
      token: reply.token,
      url: typeof reply.url === "string" ? reply.url : "http://127.0.0.1:5123",
    };
  }

  async start(): Promise<HostStatus> {
    return this.#manage("start");
  }

  async stop(): Promise<HostStatus> {
    return this.#manage("stop");
  }

  async #manage(type: "start" | "stop"): Promise<HostStatus> {
    const reply = await this.#request(type);
    if (!reply) {
      throw new Error("The server helper is not installed. Run the server installer.");
    }
    return parseStatus(reply);
  }

  async #request(type: string): Promise<Record<string, unknown> | null> {
    let reply: unknown;
    try {
      reply = await this.#send(NATIVE_HOST_NAME, { type });
    } catch (error) {
      if (error instanceof Error && HOST_MISSING.test(error.message)) {
        return null;
      }
      throw error;
    }
    if (!isRecord(reply) || reply.ok !== true) {
      throw new Error(
        isRecord(reply) && typeof reply.error === "string"
          ? reply.error
          : "The server helper did not answer.",
      );
    }
    return reply;
  }
}

export interface SettingsAccess {
  load(): Promise<AppSettings>;
  update(patch: SettingsPatch): Promise<AppSettings>;
}

interface ConnectionOptions {
  host?: ServerHost;
  createEngine?: (url: string, token: string) => ServerEngine;
  ping?: (url: string) => Promise<{ version: string | null } | null>;
  now?: () => number;
}

/**
 * Finds the local server and keeps the extension connected to it. With the
 * native host installed this needs no pairing code: a missing or rejected
 * token is replaced by asking the host.
 */
export class ServerConnection {
  readonly #settings: SettingsAccess;
  readonly #host: ServerHost;
  readonly #createEngine: (url: string, token: string) => ServerEngine;
  readonly #ping: (url: string) => Promise<{ version: string | null } | null>;
  readonly #now: () => number;
  #engine: { url: string; token: string; engine: ServerEngine } | null = null;
  // Spawning the host costs a process, so failed attempts wait a little.
  #retryHostAt = 0;

  constructor(settings: SettingsAccess, options: ConnectionOptions = {}) {
    this.#settings = settings;
    this.#host = options.host ?? new ServerHost();
    this.#createEngine =
      options.createEngine ?? ((url, token) => new ServerEngine(url, token));
    this.#ping = options.ping ?? pingServer;
    this.#now = options.now ?? Date.now;
  }

  /** The last engine handed out, for callers that only need a cached one. */
  get current(): ServerEngine | null {
    return this.#engine?.engine ?? null;
  }

  /** A connected engine, or null when the server is off or disabled. */
  async engine(refresh = false): Promise<ServerEngine | null> {
    const settings = await this.#settings.load();
    if (!settings.server.enabled) return null;
    if (settings.server.token) {
      const engine = this.#engineFor(settings.server.url, settings.server.token);
      if (await engine.health(refresh)) return engine;
    }
    const connection = await this.#connectThroughHost();
    if (!connection?.running) return null;
    const server =
      connection.token === settings.server.token
        ? settings.server
        : (
            await this.#settings.update({
              server: { url: connection.url, token: connection.token },
            })
          ).server;
    const engine = this.#engineFor(server.url, server.token);
    return (await engine.health(true)) ? engine : null;
  }

  async state(): Promise<ServerState> {
    const settings = await this.#settings.load();
    let status: HostStatus | null = null;
    let error: string | undefined;
    try {
      status = await this.#host.status();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The server helper failed.";
    }
    const pinged = status ? null : await this.#ping(settings.server.url);
    const running = status ? status.running : pinged !== null;
    let connected = false;
    if (running && settings.server.enabled) {
      this.#retryHostAt = 0;
      connected = (await this.engine(true)) !== null;
    }
    return {
      enabled: settings.server.enabled,
      helper: status !== null,
      running,
      connected,
      canManage: status?.canManage ?? false,
      version: status?.version ?? pinged?.version ?? null,
      error,
    };
  }

  async start(): Promise<ServerState> {
    await this.#host.start();
    this.#retryHostAt = 0;
    return this.state();
  }

  async stop(): Promise<ServerState> {
    await this.#host.stop();
    // The engine caches a healthy check for 30 seconds.
    this.#engine = null;
    return this.state();
  }

  #engineFor(url: string, token: string): ServerEngine {
    if (this.#engine?.url !== url || this.#engine.token !== token) {
      this.#engine = { url, token, engine: this.#createEngine(url, token) };
    }
    return this.#engine.engine;
  }

  async #connectThroughHost(): Promise<HostConnection | null> {
    if (this.#now() < this.#retryHostAt) return null;
    try {
      const connection = await this.#host.connect();
      this.#retryHostAt =
        this.#now() + (!connection ? 60_000 : connection.running ? 0 : 5_000);
      return connection;
    } catch {
      this.#retryHostAt = this.#now() + 5_000;
      return null;
    }
  }
}

/** Whether an Open Speechy server answers at the URL. Needs no token. */
export async function pingServer(
  url: string,
): Promise<{ version: string | null } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${normalizeServerUrl(url)}/ping`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || body.app !== "open-speechy") return null;
    return { version: typeof body.version === "string" ? body.version : null };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseStatus(reply: Record<string, unknown>): HostStatus {
  return {
    running: reply.running === true,
    version: typeof reply.version === "string" ? reply.version : null,
    canManage: reply.canManage === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
