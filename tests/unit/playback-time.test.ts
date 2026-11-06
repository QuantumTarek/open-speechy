import { afterEach, expect, it, vi } from "vitest";
import { playbackEpochTime, playbackLocalTime } from "../../src/playback/time";

afterEach(() => vi.restoreAllMocks());

it("aligns a new audio document with a tab that was open before system sleep", () => {
  const wallNow = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockReturnValue(wallNow);
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const audioStart = playbackEpochTime(400);
  expect(audioStart).toBe(wallNow + 300);

  // The old tab has a different monotonic clock and has missed hours of sleep.
  now.mockReturnValue(60_000);
  vi.mocked(Date.now).mockReturnValue(wallNow + 25);
  expect(playbackLocalTime(audioStart)).toBe(60_275);
});
