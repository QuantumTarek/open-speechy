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

const KOKORO_ACCENTS: Record<string, string> = {
  a: "American",
  b: "British",
};

// "af_heart" -> "Heart", described as "American · female".
export function kokoroVoiceName(voice: string): string {
  const name = voice.split("_").slice(1).join(" ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function kokoroVoiceDescription(voice: string): string {
  const accent = KOKORO_ACCENTS[voice.charAt(0)] ?? "English";
  return `${accent} · ${voice.charAt(1) === "m" ? "male" : "female"}`;
}

export function browserVoiceCatalog(): VoiceInfo[] {
  return [
    ...KOKORO_VOICES.map((name) => ({
      id: `kokoro:${name}`,
      engineId: "kokoro" as const,
      lang: "en" as const,
      name: kokoroVoiceName(name),
      description: kokoroVoiceDescription(name),
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
      description: "Jordanian Arabic · male",
      quality: "standard",
      local: true,
      supportsWordTimings: false,
      sizeBytes: 61_000_000,
      installed: false,
    },
  ];
}

export type VoiceGender = "female" | "male";

// Apple's natural (Premium and Enhanced) voices. Chrome does not report a
// voice's gender, so system voices not listed here have none.
const SYSTEM_VOICE_GENDERS: Record<string, VoiceGender> = {
  Allison: "female",
  Ava: "female",
  Catherine: "female",
  Fiona: "female",
  Isha: "female",
  Joelle: "female",
  Karen: "female",
  Kate: "female",
  Laila: "female",
  Mariam: "female",
  Martha: "female",
  Matilda: "female",
  Moira: "female",
  Nicky: "female",
  Noelle: "female",
  Samantha: "female",
  Serena: "female",
  Stephanie: "female",
  Susan: "female",
  Tessa: "female",
  Veena: "female",
  Zoe: "female",
  Aaron: "male",
  Alex: "male",
  Arthur: "male",
  Daniel: "male",
  Evan: "male",
  Gordon: "male",
  Jamie: "male",
  Lee: "male",
  Maged: "male",
  Majed: "male",
  Nathan: "male",
  Oliver: "male",
  Rishi: "male",
  Tarik: "male",
  Tom: "male",
};

/** The voice's gender when it is known: Kokoro IDs encode it ("af_", "am_"). */
export function voiceGender(voice: VoiceInfo): VoiceGender | undefined {
  const kokoro = voice.id.match(/^(?:server:)?kokoro:[a-z]([fm])_/u);
  if (kokoro) return kokoro[1] === "f" ? "female" : "male";
  if (voice.id === "piper:ar_JO-kareem-medium") return "male";
  if (voice.engineId === "system") {
    return SYSTEM_VOICE_GENDERS[voice.name.replace(/\s*\(.*$/u, "")];
  }
  return undefined;
}
