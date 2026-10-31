import { afterEach, describe, expect, it, vi } from "vitest";
import type { Highlighter } from "../../src/highlight/highlighter";
import { PlaybackClock, type ClockSegment } from "../../src/playback/clock";

function segment(
  sentenceId: string,
  wordIndex: number,
  startedAtPerf: number,
  generation: number,
): ClockSegment {
  return {
    sentenceId,
    timings: [{ wordIndex, startMs: 0, endMs: 1_000 }],
    durationMs: 1_000,
    rate: 1,
    startedAtPerf,
    generation,
  };
}

describe("playback clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops audio segments that were queued before a seek", () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "performance"],
    });
    const highlighted: Array<number | null> = [];
    const highlighter = {
      highlightWord: (wordIndex: number | null) => highlighted.push(wordIndex),
    } as unknown as Highlighter;
    const clock = new PlaybackClock(highlighter, () => {});
    const now = performance.now();

    clock.addSegment(segment("before-seek", 5, now + 100, 1));
    clock.addSegment(segment("after-seek", 20, now + 50, 2));
    // A late event from before the seek must not come back.
    clock.addSegment(segment("before-seek", 6, now + 120, 1));
    vi.advanceTimersByTime(200);

    expect(highlighted.at(-1)).toBe(20);
    expect(highlighted).not.toContain(5);
    expect(highlighted).not.toContain(6);
    clock.stop();
  });

  it("advances at word boundaries without waking on every frame", () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "performance"],
    });
    const words: number[] = [];
    const highlighter = { highlightWord: () => {} } as unknown as Highlighter;
    const clock = new PlaybackClock(highlighter, (tick) =>
      words.push(tick.wordIndex),
    );
    clock.addSegment({
      sentenceId: "s0",
      timings: [
        { wordIndex: 0, startMs: 0, endMs: 400 },
        { wordIndex: 1, startMs: 400, endMs: 1_000 },
      ],
      durationMs: 1_000,
      rate: 1,
      startedAtPerf: performance.now() + 100,
      generation: 0,
    });

    vi.advanceTimersByTime(50);
    expect(words).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(words).toEqual([0]);
    vi.advanceTimersByTime(400);
    expect(words).toEqual([0, 1]);
    // A single pending wake-up for the next boundary, not a frame loop.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    clock.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
