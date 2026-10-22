import { describe, expect, it } from "vitest";
import { selectVoice } from "../../src/engines/router";
import { mapSystemVoice } from "../../src/engines/system";
import type { VoiceInfo } from "../../src/engines/types";

const SYSTEM_EVENTS: NonNullable<chrome.tts.TtsVoice["eventTypes"]> = [
  "word",
  "end",
  "interrupted",
];

function voice(
  id: string,
  engineId: VoiceInfo["engineId"],
  lang: VoiceInfo["lang"],
  quality: VoiceInfo["quality"],
  overrides: Partial<VoiceInfo> = {},
): VoiceInfo {
  return {
    id,
    engineId,
    lang,
    name: id,
    quality,
    local: true,
    supportsWordTimings: false,
    installed: true,
    ...overrides,
  };
}

function options(
  overrides: Partial<Parameters<typeof selectVoice>[1]> = {},
): Parameters<typeof selectVoice>[1] {
  return {
    systemVoices: [],
    serverVoices: [],
    serverPaired: false,
    serverHealthy: false,
    localVoices: [
      voice("kokoro:af_heart", "kokoro", "en", "standard"),
      voice(
        "piper:ar_JO-kareem-medium",
        "piper",
        "ar",
        "standard",
        { installed: false },
      ),
    ],
    ...overrides,
  };
}

describe("voice selection", () => {
  it("prefers a local Premium system voice over Enhanced and browser voices", () => {
    const enhanced = voice(
      "system:en-GB:Alex (Enhanced)",
      "system",
      "en",
      "enhanced",
      { supportsWordTimings: true },
    );
    const premium = voice(
      "system:en-US:Zoe (Premium)",
      "system",
      "en",
      "premium",
      { supportsWordTimings: true },
    );

    const selected = selectVoice("en", options({
      systemVoices: [
        { voice: enhanced, eventTypes: SYSTEM_EVENTS },
        { voice: premium, eventTypes: SYSTEM_EVENTS },
      ],
    }));

    expect(selected.voice.id).toBe(premium.id);
    expect(selected.overrideUnavailable).toBe(false);
  });

  it("does not auto-select compact, remote, or incomplete system voices", () => {
    const candidates = [
      {
        voice: voice(
          "system:Compact",
          "system",
          "en",
          "compact",
          { supportsWordTimings: true },
        ),
        eventTypes: SYSTEM_EVENTS,
      },
      {
        voice: voice(
          "system:Remote (Premium)",
          "system",
          "en",
          "premium",
          { local: false, supportsWordTimings: true },
        ),
        eventTypes: SYSTEM_EVENTS,
      },
      {
        voice: voice(
          "system:NoEnd (Premium)",
          "system",
          "en",
          "premium",
          { supportsWordTimings: true },
        ),
        eventTypes: ["word", "interrupted"],
      },
    ];

    expect(
      selectVoice("en", options({ systemVoices: candidates })).voice.id,
    ).toBe("kokoro:af_heart");
  });

  it("uses the server only when paired and healthy", () => {
    const serverVoice = voice(
      "server:kokoro:af_heart",
      "server",
      "en",
      "standard",
    );
    const input = options({ serverVoices: [serverVoice] });

    expect(selectVoice("en", input).voice.id).toBe("kokoro:af_heart");
    expect(
      selectVoice("en", {
        ...input,
        serverPaired: true,
        serverHealthy: true,
      }).voice.id,
    ).toBe(serverVoice.id);
  });

  it("falls through when a saved override is missing", () => {
    const selected = selectVoice(
      "ar",
      options({ override: "system:missing" }),
    );

    expect(selected.voice.id).toBe("piper:ar_JO-kareem-medium");
    expect(selected.overrideUnavailable).toBe(true);
  });

  it("maps Chrome voices without treating unknown or remote voices as local", () => {
    expect(
      mapSystemVoice({
        voiceName: "Majed (Enhanced)",
        lang: "ar-SA",
        remote: false,
        eventTypes: SYSTEM_EVENTS,
      }),
    ).toMatchObject({
      id: "system:ar-SA:Majed (Enhanced)",
      engineId: "system",
      lang: "ar",
      quality: "enhanced",
      local: true,
      supportsWordTimings: true,
    });
    expect(
      mapSystemVoice({
        voiceName: "Remote English (Premium)",
        lang: "en-US",
        remote: true,
        eventTypes: SYSTEM_EVENTS,
      })?.local,
    ).toBe(false);
    expect(mapSystemVoice({ voiceName: "Unknown" })).toBeUndefined();
  });
});
