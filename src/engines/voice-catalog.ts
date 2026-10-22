import type { VoiceInfo } from "./types";

export const KOKORO_VOICES = [
  "af_heart",
  "af_alloy",
  "af_aoede",
  "af_bella",
  "af_jessica",
  "af_kore",
  "af_nicole",
  "af_nova",
  "af_river",
  "af_sarah",
  "af_sky",
  "am_adam",
  "am_echo",
  "am_eric",
  "am_fenrir",
  "am_liam",
  "am_michael",
  "am_onyx",
  "am_puck",
  "am_santa",
  "bf_alice",
  "bf_emma",
  "bf_isabella",
  "bf_lily",
  "bm_daniel",
  "bm_fable",
  "bm_george",
  "bm_lewis",
] as const;

export function browserVoiceCatalog(): VoiceInfo[] {
  return [
    ...KOKORO_VOICES.map((name) => ({
      id: `kokoro:${name}`,
      engineId: "kokoro" as const,
      lang: "en" as const,
      name,
      quality: "standard" as const,
      local: true,
      supportsWordTimings: false,
      sizeBytes: name === "af_heart" ? 90_000_000 : undefined,
      installed: false,
    })),
    {
      id: "piper:ar_JO-kareem-medium",
      engineId: "piper",
      lang: "ar",
      name: "Kareem",
      quality: "standard",
      local: true,
      supportsWordTimings: false,
      sizeBytes: 61_000_000,
      installed: false,
    },
  ];
}
