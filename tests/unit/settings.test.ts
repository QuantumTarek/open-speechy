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

  it("keeps a server token another context saved since it loaded", async () => {
    const storage = new MemorySettings();
    const localStorage = new MemorySettings();
    const optionsPage = new SettingsStore(storage, localStorage);
    await optionsPage.load();

    await new SettingsStore(storage, localStorage).update({
      server: { token: "auto-connected" },
    });
    const updated = await optionsPage.update({ speed: 1.5 });

    expect(updated.server.token).toBe("auto-connected");
    expect(localStorage.values.openSpeechyServerToken).toBe("auto-connected");
  });

  it("uses Speechify's palette and moves the old default colors to it", async () => {
    const sync = new MemorySettings();
    sync.values.highlight = {
      enabled: true,
      word: "rgba(255, 179, 0, 0.6)",
      sentence: "rgba(255, 213, 79, 0.25)",
    };
    const store = new SettingsStore(sync, new MemorySettings());

    expect(DEFAULT_SETTINGS.highlight).toMatchObject({
      word: "#abb3fe",
      sentence: "#e0e3ff",
    });
    expect((await store.load()).highlight).toEqual(DEFAULT_SETTINGS.highlight);
    expect(
      (await store.update({ highlight: { word: "#123456" } })).highlight.word,
    ).toBe("#123456");
  });

  it("validates feature switches and highlight colors", async () => {
    const store = new SettingsStore(new MemorySettings(), new MemorySettings());

    const updated = await store.update({
      autoScroll: false,
      readCodeBlocks: true,
      selectionChip: false,
      highlight: {
        enabled: false,
        word: "rgba(20, 40, 60, 0.7)",
        sentence: "url(javascript:alert(1))",
      },
      pdf: { intercept: false },
      arabic: { diacritize: true },
      server: { enabled: false },
    });

    expect(updated.autoScroll).toBe(false);
    expect(updated.readCodeBlocks).toBe(true);
    expect(updated.selectionChip).toBe(false);
    expect(updated.highlight).toEqual({
      enabled: false,
      word: "rgba(20, 40, 60, 0.7)",
      sentence: DEFAULT_SETTINGS.highlight.sentence,
    });
    expect(updated.pdf.intercept).toBe(false);
    expect(updated.arabic.diacritize).toBe(true);
    expect(updated.server.enabled).toBe(false);
  });
});
