import type { Lang } from "../engines/types";

export interface AppSettings {
  voice: Record<Lang, string>;
  speed: number;
  highlight: {
    enabled: boolean;
    word: string;
    sentence: string;
  };
  autoScroll: boolean;
  lookahead: number;
  readCodeBlocks: boolean;
  urls: "skip" | "domain" | "full";
  selectionChip: boolean;
  pdf: { intercept: boolean };
  arabic: { diacritize: boolean };
  server: {
    enabled: boolean;
    url: string;
    token: string;
  };
  idleUnloadMinutes: number;
}

export type SettingsPatch = Omit<
  Partial<AppSettings>,
  "voice" | "highlight" | "pdf" | "arabic" | "server"
> & {
  voice?: Partial<AppSettings["voice"]>;
  highlight?: Partial<AppSettings["highlight"]>;
  pdf?: Partial<AppSettings["pdf"]>;
  arabic?: Partial<AppSettings["arabic"]>;
  server?: Partial<AppSettings["server"]>;
};

export const DEFAULT_SETTINGS: AppSettings = {
  voice: { en: "auto", ar: "auto" },
  speed: 1,
  highlight: {
    enabled: true,
    word: "rgba(255, 179, 0, 0.6)",
    sentence: "rgba(255, 213, 79, 0.25)",
  },
  autoScroll: true,
  lookahead: 2,
  readCodeBlocks: false,
  urls: "domain",
  selectionChip: true,
  pdf: { intercept: true },
  arabic: { diacritize: false },
  server: {
    enabled: true,
    url: "http://127.0.0.1:5123",
    token: "",
  },
  idleUnloadMinutes: 5,
};

export interface SettingsStorage {
  get(
    keys?: string | string[] | Record<string, unknown> | null,
  ): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class SettingsStore {
  readonly #syncStorage: SettingsStorage;
  readonly #localStorage: SettingsStorage;
  #current: AppSettings | null = null;

  constructor(
    syncStorage: SettingsStorage = chrome.storage.sync,
    localStorage: SettingsStorage = chrome.storage.local,
  ) {
    this.#syncStorage = syncStorage;
    this.#localStorage = localStorage;
  }

  async load(): Promise<AppSettings> {
    if (this.#current) return structuredClone(this.#current);
    const [stored, local] = await Promise.all([
      this.#syncStorage.get(null),
      this.#localStorage.get("openSpeechyServerToken"),
    ]);
    const localToken = local.openSpeechyServerToken;
    this.#current = mergeSettings({
      ...stored,
      server: {
        ...(stored.server as Partial<AppSettings["server"]> | undefined),
        token:
          typeof localToken === "string"
            ? localToken
            : getStoredServerToken(stored.server),
      },
    });
    return structuredClone(this.#current);
  }

  async update(patch: SettingsPatch): Promise<AppSettings> {
    const current = await this.load();
    this.#current = mergeSettings({
      ...current,
      ...patch,
      voice: { ...current.voice, ...patch.voice },
      highlight: { ...current.highlight, ...patch.highlight },
      pdf: { ...current.pdf, ...patch.pdf },
      arabic: { ...current.arabic, ...patch.arabic },
      server: { ...current.server, ...patch.server },
    });
    const syncedSettings = {
      ...this.#current,
      server: { ...this.#current.server, token: "" },
    };
    await Promise.all([
      this.#syncStorage.set(
        syncedSettings as unknown as Record<string, unknown>,
      ),
      this.#localStorage.set({
        openSpeechyServerToken: this.#current.server.token,
      }),
    ]);
    return structuredClone(this.#current);
  }
}

function getStoredServerToken(value: unknown): string {
  if (typeof value !== "object" || value === null || !("token" in value)) {
    return "";
  }
  return typeof value.token === "string" ? value.token : "";
}

function mergeSettings(value: Record<string, unknown>): AppSettings {
  const voice =
    typeof value.voice === "object" && value.voice !== null
      ? (value.voice as Partial<AppSettings["voice"]>)
      : {};
  const highlight =
    typeof value.highlight === "object" && value.highlight !== null
      ? (value.highlight as Partial<AppSettings["highlight"]>)
      : {};
  const pdf =
    typeof value.pdf === "object" && value.pdf !== null
      ? (value.pdf as Partial<AppSettings["pdf"]>)
      : {};
  const arabic =
    typeof value.arabic === "object" && value.arabic !== null
      ? (value.arabic as Partial<AppSettings["arabic"]>)
      : {};
  const server =
    typeof value.server === "object" && value.server !== null
      ? (value.server as Partial<AppSettings["server"]>)
      : {};

  return {
    ...DEFAULT_SETTINGS,
    ...value,
    voice: { ...DEFAULT_SETTINGS.voice, ...voice },
    highlight: {
      enabled: booleanOr(highlight.enabled, DEFAULT_SETTINGS.highlight.enabled),
      word: colorOr(highlight.word, DEFAULT_SETTINGS.highlight.word),
      sentence: colorOr(highlight.sentence, DEFAULT_SETTINGS.highlight.sentence),
    },
    pdf: {
      intercept: booleanOr(pdf.intercept, DEFAULT_SETTINGS.pdf.intercept),
    },
    arabic: {
      diacritize: booleanOr(
        arabic.diacritize,
        DEFAULT_SETTINGS.arabic.diacritize,
      ),
    },
    server: {
      ...DEFAULT_SETTINGS.server,
      ...server,
      enabled: booleanOr(server.enabled, DEFAULT_SETTINGS.server.enabled),
    },
    speed: clampNumber(value.speed, 0.5, 3, DEFAULT_SETTINGS.speed),
    lookahead: clampNumber(value.lookahead, 1, 4, DEFAULT_SETTINGS.lookahead),
    idleUnloadMinutes: clampNumber(
      value.idleUnloadMinutes,
      1,
      120,
      DEFAULT_SETTINGS.idleUnloadMinutes,
    ),
    urls:
      value.urls === "skip" || value.urls === "full"
        ? value.urls
        : DEFAULT_SETTINGS.urls,
    autoScroll: booleanOr(value.autoScroll, DEFAULT_SETTINGS.autoScroll),
    readCodeBlocks: booleanOr(
      value.readCodeBlocks,
      DEFAULT_SETTINGS.readCodeBlocks,
    ),
    selectionChip: booleanOr(value.selectionChip, DEFAULT_SETTINGS.selectionChip),
  } as AppSettings;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function colorOr(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 64) return fallback;
  return /^(?:#[\da-f]{3,8}|rgba?\([\d\s.,%]+\))$/iu.test(value)
    ? value
    : fallback;
}

function clampNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}
