import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  type SettingsStorage,
} from "../../src/settings/store";

class MemorySettings implements SettingsStorage {
  readonly values: Record<string, unknown> = {};

  async get(): Promise<Record<string, unknown>> {
    return structuredClone(this.values);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, structuredClone(items));
  }
}

describe("settings", () => {
  it("loads defaults when no values have been saved", async () => {
    const store = new SettingsStore(new MemorySettings(), new MemorySettings());

    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it("merges nested updates and clamps numeric values", async () => {
    const storage = new MemorySettings();
    const localStorage = new MemorySettings();
    const store = new SettingsStore(storage, localStorage);

    const updated = await store.update({
      voice: { en: "kokoro:af_heart", ar: "auto" },
      speed: 8,
      lookahead: 0,
      server: { token: "local-token" },
    });

    expect(updated.voice).toEqual({
      en: "kokoro:af_heart",
      ar: "auto",
    });
    expect(updated.speed).toBe(3);
    expect(updated.lookahead).toBe(1);
    expect(updated.server.token).toBe("local-token");
    expect(storage.values.server).toMatchObject({ token: "" });
    expect(localStorage.values.openSpeechyServerToken).toBe("local-token");
    expect((await store.load()).server.url).toBe(DEFAULT_SETTINGS.server.url);
  });
});
