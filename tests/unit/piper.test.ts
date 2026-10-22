import { describe, expect, it } from "vitest";
import {
  parsePiperPhonemeOutput,
  piperScales,
} from "../../src/engines/piper-utils";

describe("Piper inference helpers", () => {
  it("ignores phonemizer status output and reads Piper's JSON result", () => {
    expect(
      parsePiperPhonemeOutput([
        "Initializing espeak",
        JSON.stringify({ phoneme_ids: [1, 14, 29, 2] }),
      ]),
    ).toEqual([1, 14, 29, 2]);
  });

  it("rejects malformed phonemizer output", () => {
    expect(() => parsePiperPhonemeOutput(["not json"])).toThrow(
      "Piper phonemization returned no phoneme IDs.",
    );
    expect(() =>
      parsePiperPhonemeOutput([JSON.stringify({ phoneme_ids: [-1] })]),
    ).toThrow();
  });

  it("maps playback speed to the VITS length scale", () => {
    const scales = piperScales(
      { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 },
      2,
    );

    expect(scales[0]).toBeCloseTo(0.667);
    expect(scales[1]).toBe(0.5);
    expect(scales[2]).toBeCloseTo(0.8);
  });
});
