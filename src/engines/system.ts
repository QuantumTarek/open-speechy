import type {
  Lang,
  SynthesisRequest,
  StreamingSpeechEngine,
  StreamingSpeechHandlers,
  VoiceInfo,
} from "./types";

const REQUIRED_AUTO_EVENTS = new Set(["word", "end", "interrupted"]);

export interface ChromeTtsApi {
  getVoices(): Promise<chrome.tts.TtsVoice[]>;
  speak(text: string, options: chrome.tts.TtsOptions): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export function systemVoiceQuality(
  voiceName: string,
): VoiceInfo["quality"] {
  const normalized = voiceName.toLowerCase();
  if (normalized.includes("(premium)")) return "premium";
  if (normalized.includes("(enhanced)")) return "enhanced";
  if (normalized.includes("(compact)")) return "compact";
  return "standard";
}

export function systemVoiceSupportsWordEvents(
  voice: chrome.tts.TtsVoice,
): boolean {
  return (voice.eventTypes ?? []).includes("word");
}

export function isAutomaticSystemVoice(
  voice: VoiceInfo,
  eventTypes: string[] = [],
): boolean {
  return (
    voice.engineId === "system" &&
    voice.local &&
    (voice.quality === "premium" || voice.quality === "enhanced") &&
    voice.supportsWordTimings &&
    [...REQUIRED_AUTO_EVENTS].every((event) => eventTypes.includes(event))
  );
}

export function mapSystemVoice(
  voice: chrome.tts.TtsVoice,
): VoiceInfo | undefined {
  const voiceName = voice.voiceName?.trim();
  const lang = normalizeLanguage(voice.lang);
  if (!voiceName || !lang) return undefined;
  return {
    id: `system:${voice.lang ?? lang}:${voiceName}`,
    engineId: "system",
    lang,
    name: voiceName,
    quality: systemVoiceQuality(voiceName),
    local: voice.remote === false,
    supportsWordTimings: systemVoiceSupportsWordEvents(voice),
    installed: true,
  };
}

export function wordIndexAtCharIndex(
  request: SynthesisRequest,
  charIndex: number,
): number | undefined {
  if (!Number.isFinite(charIndex) || charIndex < 0) return undefined;
  let offset = 0;
  let found: number | undefined;

  for (let index = 0; index < request.words.length; index += 1) {
    const word = request.words[index];
    const end = offset + word.length;
    if (charIndex < end || index === request.words.length - 1) {
      found = request.wordIndices[index] ?? index;
      break;
    }
    offset = end + 1;
  }

  return found;
}

export class SystemTtsEngine implements StreamingSpeechEngine {
  readonly id = "system" as const;
  readonly #voice: VoiceInfo;
  readonly #api: ChromeTtsApi;

  constructor(
    voice: VoiceInfo,
    api: ChromeTtsApi = chrome.tts,
  ) {
    if (voice.engineId !== "system") {
      throw new Error("SystemTtsEngine requires a system voice.");
    }
    this.#voice = voice;
    this.#api = api;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const voices = await this.#api.getVoices();
    return voices.flatMap((voice) => {
      const mapped = mapSystemVoice(voice);
      return mapped ? [mapped] : [];
    });
  }

  speak(
    request: SynthesisRequest,
    handlers: StreamingSpeechHandlers,
  ): void {
    if (!request.text.trim()) {
      handlers.onError(new Error("No speech text was provided."));
      return;
    }
    const voiceName = this.#voice.name;
    this.#api.speak(request.text, {
      voiceName,
      lang: request.lang,
      rate: Math.min(3, Math.max(0.5, request.speed)),
      enqueue: false,
      desiredEventTypes: ["start", "word", "end", "interrupted", "error"],
      onEvent: (event) => {
        if (event.type === "start") {
          handlers.onStart();
        } else if (event.type === "word" && event.charIndex !== undefined) {
          const wordIndex = wordIndexAtCharIndex(request, event.charIndex);
          if (wordIndex !== undefined) handlers.onWord(wordIndex, event);
        } else if (event.type === "end") {
          handlers.onEnd();
        } else if (event.type === "error") {
          handlers.onError(
            new Error(event.errorMessage || "System speech failed."),
          );
        } else if (
          event.type === "interrupted" ||
          event.type === "cancelled"
        ) {
          handlers.onError(new Error("System speech was interrupted."));
        }
      },
    });
  }

  pause(): void {
    this.#api.pause();
  }

  resume(): void {
    this.#api.resume();
  }

  stop(): void {
    this.#api.stop();
  }
}

function normalizeLanguage(value: string | undefined): Lang | undefined {
  const lang = value?.toLowerCase();
  if (lang?.startsWith("en")) return "en";
  if (lang?.startsWith("ar")) return "ar";
  return undefined;
}
