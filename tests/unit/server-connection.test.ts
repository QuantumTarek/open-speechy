import { describe, expect, it, vi } from "vitest";
import type { ServerEngine } from "../../src/engines/server";
import {
  NATIVE_HOST_NAME,
  ServerConnection,
  ServerHost,
  type SendNativeMessage,
  type SettingsAccess,
} from "../../src/engines/server-connection";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsPatch,
} from "../../src/settings/store";

class MemorySettings implements SettingsAccess {
  value: AppSettings = structuredClone(DEFAULT_SETTINGS);
  updates = 0;

  async load(): Promise<AppSettings> {
    return structuredClone(this.value);
  }

  async update(patch: SettingsPatch): Promise<AppSettings> {
    this.updates += 1;
    this.value = {
      ...this.value,
      server: { ...this.value.server, ...patch.server },
    };
    return structuredClone(this.value);
  }
}

// The server accepts only `validToken`. An empty one means it is stopped.
function fakeServer(validToken: { value: string }) {
  return (_url: string, token: string) =>
    ({
      token,
      health: vi.fn(async () =>
        validToken.value && token === validToken.value
          ? { ok: true, version: "0.1.0", device: "cpu", engines: [] }
          : null,
      ),
    }) as unknown as ServerEngine;
}

function hostReplying(
  replies: Record<string, unknown>,
): { host: ServerHost; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async (_host: string, message: Record<string, unknown>) => {
    const reply = replies[message.type as string];
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { host: new ServerHost(send as SendNativeMessage), send };
}

const RUNNING = { ok: true, running: true, version: "0.1.0", canManage: true };

describe("server host", () => {
  it("treats a missing or forbidden host as not installed", async () => {
    for (const message of [
      "Specified native messaging host not found.",
      "Access to the specified native messaging host is forbidden.",
    ]) {
      const { host } = hostReplying({ status: new Error(message) });
      expect(await host.status()).toBeNull();
    }
    const { host } = hostReplying({ status: new Error("Native host has exited.") });
    await expect(host.status()).rejects.toThrow("Native host has exited.");
  });

  it("passes on host errors and reads the connection", async () => {
    const { host, send } = hostReplying({
      start: { ok: false, error: "The server service is not installed." },
      connect: { ...RUNNING, token: "secret", url: "http://127.0.0.1:5123" },
    });

    await expect(host.start()).rejects.toThrow("The server service is not installed.");
    expect(await host.connect()).toEqual({
      running: true,
      version: "0.1.0",
      canManage: true,
      token: "secret",
      url: "http://127.0.0.1:5123",
    });
    expect(send).toHaveBeenCalledWith(NATIVE_HOST_NAME, { type: "connect" });
  });
});

describe("server connection", () => {
  it("connects through the host when there is no token, then reuses it", async () => {
    const settings = new MemorySettings();
    const { host, send } = hostReplying({
      connect: { ...RUNNING, token: "secret", url: "http://127.0.0.1:5123" },
    });
    const connection = new ServerConnection(settings, {
      host,
      createEngine: fakeServer({ value: "secret" }),
    });

    expect(await connection.engine()).not.toBeNull();
    expect(settings.value.server.token).toBe("secret");
    expect(await connection.engine()).not.toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("replaces a token the server rejects", async () => {
    const settings = new MemorySettings();
    settings.value.server.token = "old";
    const { host } = hostReplying({
      connect: { ...RUNNING, token: "new", url: "http://127.0.0.1:5123" },
    });
    const connection = new ServerConnection(settings, {
      host,
      createEngine: fakeServer({ value: "new" }),
    });

    expect(await connection.engine()).not.toBeNull();
    expect(settings.value.server.token).toBe("new");
  });

  it("waits a minute before asking a missing host again", async () => {
    let now = 0;
    const { host, send } = hostReplying({
      connect: new Error("Specified native messaging host not found."),
    });
    const connection = new ServerConnection(new MemorySettings(), {
      host,
      createEngine: fakeServer({ value: "" }),
      now: () => now,
    });

    expect(await connection.engine()).toBeNull();
    now += 59_000;
    expect(await connection.engine()).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    now += 2_000;
    await connection.engine();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not connect when the user turned the server off", async () => {
    const settings = new MemorySettings();
    settings.value.server.enabled = false;
    const { host, send } = hostReplying({});
    const connection = new ServerConnection(settings, { host });

    expect(await connection.engine()).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("reports state from the host, or from a ping without one", async () => {
    const valid = { value: "secret" };
    const { host } = hostReplying({
      status: RUNNING,
      connect: { ...RUNNING, token: "secret", url: "http://127.0.0.1:5123" },
    });
    const connection = new ServerConnection(new MemorySettings(), {
      host,
      createEngine: fakeServer(valid),
    });
    expect(await connection.state()).toEqual({
      enabled: true,
      helper: true,
      running: true,
      connected: true,
      canManage: true,
      version: "0.1.0",
      error: undefined,
    });

    const withoutHost = new ServerConnection(new MemorySettings(), {
      host: hostReplying({
        status: new Error("Specified native messaging host not found."),
        connect: new Error("Specified native messaging host not found."),
      }).host,
      createEngine: fakeServer(valid),
      ping: async () => ({ version: "0.1.0" }),
    });
    expect(await withoutHost.state()).toMatchObject({
      helper: false,
      running: true,
      connected: false,
      canManage: false,
    });
  });

  it("forgets the healthy engine when it stops the server", async () => {
    const valid = { value: "secret" };
    const replies: Record<string, unknown> = {
      status: RUNNING,
      connect: { ...RUNNING, token: "secret", url: "http://127.0.0.1:5123" },
      stop: { ...RUNNING, running: false },
    };
    const { host } = hostReplying(replies);
    const connection = new ServerConnection(new MemorySettings(), {
      host,
      createEngine: fakeServer(valid),
    });
    expect(await connection.engine()).not.toBeNull();
    const before = connection.current;

    valid.value = "";
    replies.status = { ...RUNNING, running: false };
    replies.connect = { ...RUNNING, running: false, token: "secret", url: "http://127.0.0.1:5123" };
    const state = await connection.stop();

    expect(state).toMatchObject({ running: false, connected: false });
    expect(connection.current).toBeNull();
    expect(before).not.toBeNull();
  });
});
