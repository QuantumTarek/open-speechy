import { describe, expect, it, vi } from "vitest";
import {
  SystemTtsEngine,
  wordIndexAtCharIndex,
  type ChromeTtsApi,
} from "../../src/engines/system";
import type {
  SynthesisRequest,
  VoiceInfo,
} from "../../src/engines/types";

const VOICE: VoiceInfo = {
  id: "system:en-US:Zoe (Premium)",
  engineId: "system",
  lang: "en",
  name: "Zoe (Premium)",
  quality: "premium",
  local: true,
  supportsWordTimings: true,
  installed: true,
};

const REQUEST: SynthesisRequest = {
  sentenceId: "sentence-0",
  lang: "en",
  voiceId: VOICE.id,
  wordIndices: [12, 13, 14],
  words: ["read", "twenty four", "carefully"],
  text: "read twenty four carefully",
  speed: 1.25,
};

describe("system TTS", () => {
  it("maps Chrome char offsets to the source word index", () => {
    expect(wordIndexAtCharIndex(REQUEST, 0)).toBe(12);
    expect(wordIndexAtCharIndex(REQUEST, 5)).toBe(13);
    expect(wordIndexAtCharIndex(REQUEST, 17)).toBe(14);
    expect(wordIndexAtCharIndex(REQUEST, 10_000)).toBe(14);
    expect(wordIndexAtCharIndex(REQUEST, -1)).toBeUndefined();
  });

  it("forwards start, word, and end events with the selected speed", () => {
    const speak = vi.fn(
      (_text: string, options: chrome.tts.TtsOptions) => {
        options.onEvent?.({ type: "start" });
        options.onEvent?.({ type: "word", charIndex: 5 });
        options.onEvent?.({ type: "end" });
      },
    );
    const api: ChromeTtsApi = {
      getVoices: async () => [],
      speak,
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
    };
    const engine = new SystemTtsEngine(VOICE, api);
    const events: string[] = [];

    engine.speak(REQUEST, {
      onStart: () => events.push("start"),
      onWord: (wordIndex) => events.push(`word:${wordIndex}`),
      onEnd: () => events.push("end"),
      onError: (error) => events.push(`error:${error.message}`),
    });

    expect(events).toEqual(["start", "word:13", "end"]);
    expect(speak).toHaveBeenCalledWith(
      REQUEST.text,
      expect.objectContaining({
        voiceName: VOICE.name,
        lang: "en",
        rate: 1.25,
        enqueue: false,
      }),
    );
  });

  it("reports an empty request without calling Chrome TTS", () => {
    const speak = vi.fn();
    const engine = new SystemTtsEngine(VOICE, {
      getVoices: async () => [],
      speak,
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
    });
    const errors: string[] = [];

    engine.speak(
      { ...REQUEST, text: "  " },
      {
        onStart: () => {},
        onWord: () => {},
        onEnd: () => {},
        onError: (error) => errors.push(error.message),
      },
    );

    expect(speak).not.toHaveBeenCalled();
    expect(errors).toEqual(["No speech text was provided."]);
  });
});
