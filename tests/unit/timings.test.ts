import { describe, expect, it } from "vitest";
import { estimateWordTimings, timingForWord } from "../../src/engines/timings";

describe("estimated word timing", () => {
  it("distributes active audio monotonically and preserves leading silence", () => {
    const audio = new Float32Array(100);
    audio.fill(0.1, 20, 60);
    const timings = estimateWordTimings(
      [
        { wordIndex: 4, text: "a" },
        { wordIndex: 5, text: "longer word." },
      ],
      audio,
      100,
      "en",
    );

    expect(timings).toHaveLength(2);
    expect(timings[0].startMs).toBe(200);
    expect(timings[0].endMs).toBeGreaterThan(timings[0].startMs);
    expect(timings[1].startMs).toBe(timings[0].endMs);
    expect(timings[1].endMs).toBe(600);
  });

  it("uses the whole duration for silent audio and returns no timings for no words", () => {
    const audio = new Float32Array(24_000);
    const timings = estimateWordTimings(
      [{ wordIndex: 0, text: "quiet" }],
      audio,
      24_000,
      "en",
    );

    expect(timings).toEqual([{ wordIndex: 0, startMs: 0, endMs: 1_000 }]);
    expect(estimateWordTimings([], audio, 24_000, "en")).toEqual([]);
  });

  it("finds the timing containing a playback position", () => {
    const timings = [
      { wordIndex: 10, startMs: 0, endMs: 100 },
      { wordIndex: 11, startMs: 100, endMs: 250 },
    ];

    expect(timingForWord(timings, 0)?.wordIndex).toBe(10);
    expect(timingForWord(timings, 140)?.wordIndex).toBe(11);
    expect(timingForWord(timings, 300)?.wordIndex).toBe(11);
  });
});
