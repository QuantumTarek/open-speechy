import type { Lang, VoiceInfo } from "./types";
import { isAutomaticSystemVoice } from "./system";

export interface RouterOptions {
  override?: string;
  systemVoices: Array<{ voice: VoiceInfo; eventTypes: string[] }>;
  serverVoices: VoiceInfo[];
  serverPaired: boolean;
  serverHealthy: boolean;
  localVoices: VoiceInfo[];
}

export interface VoiceSelection {
  voice: VoiceInfo;
  overrideUnavailable: boolean;
}

export function selectVoice(
  lang: Lang,
  options: RouterOptions,
): VoiceSelection {
  const allVoices = [
    ...options.systemVoices.map(({ voice }) => voice),
    ...options.serverVoices,
    ...options.localVoices,
  ];
  const requested = options.override;
  if (requested && requested !== "auto") {
    const override = allVoices.find(
      (voice) => voice.id === requested && voice.lang === lang,
    );
    if (override) return { voice: override, overrideUnavailable: false };
  }

  const systemVoice = options.systemVoices
    .filter(
      ({ voice }) =>
        voice.lang === lang && isAutomaticSystemVoice(voice, voiceEventsFor(options.systemVoices, voice)),
    )
    .map(({ voice }) => voice)
    .sort((left, right) => {
      const qualityOrder = { premium: 0, enhanced: 1, standard: 2, compact: 3 };
      const qualityDifference =
        qualityOrder[left.quality] - qualityOrder[right.quality];
      if (qualityDifference !== 0) return qualityDifference;
      if (lang === "en") {
        const leftDefault = left.id.toLowerCase().includes("en-us") ? 0 : 1;
        const rightDefault = right.id.toLowerCase().includes("en-us") ? 0 : 1;
        return leftDefault - rightDefault;
      }
      return left.name.localeCompare(right.name);
    })[0];
  if (systemVoice) {
    return {
      voice: systemVoice,
      overrideUnavailable: Boolean(requested && requested !== "auto"),
    };
  }

  const serverVoice =
    options.serverPaired && options.serverHealthy
      ? options.serverVoices.find(
          (voice) =>
            voice.lang === lang &&
            voice.id ===
              (lang === "ar" ? "server:silma:default" : "server:kokoro:af_heart"),
        ) ??
        options.serverVoices.find((voice) => voice.lang === lang)
      : undefined;
  if (serverVoice) {
    return {
      voice: serverVoice,
      overrideUnavailable: Boolean(requested && requested !== "auto"),
    };
  }

  const preferredEngine = lang === "en" ? "kokoro" : "piper";
  const localVoice =
    options.localVoices.find(
      (voice) =>
        voice.lang === lang &&
        voice.engineId === preferredEngine &&
        (lang !== "en" || voice.id === "kokoro:af_heart"),
    ) ?? makeFallbackVoice(lang);

  return {
    voice: localVoice,
    overrideUnavailable: Boolean(requested && requested !== "auto"),
  };
}

function voiceEventsFor(
  voices: RouterOptions["systemVoices"],
  target: VoiceInfo,
): string[] {
  return voices.find(({ voice }) => voice.id === target.id)?.eventTypes ?? [];
}

function makeFallbackVoice(lang: Lang): VoiceInfo {
  return lang === "en"
    ? {
        id: "kokoro:af_heart",
        engineId: "kokoro",
        lang,
        name: "Heart",
        quality: "standard",
        local: true,
        supportsWordTimings: false,
        installed: false,
      }
    : {
        id: "piper:ar_JO-kareem-medium",
        engineId: "piper",
        lang,
        name: "Kareem",
        quality: "standard",
        local: true,
        supportsWordTimings: false,
        installed: false,
      };
}
