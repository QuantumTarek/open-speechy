import { describe, expect, it } from "vitest";
import { splitWordsForSynthesis } from "../../src/engines/text-chunks";

describe("splitting long text for Kokoro", () => {
  it("keeps short text in one part", () => {
    expect(splitWordsForSynthesis(["Hello", "there."])).toEqual([[0, 2]]);
  });

  it("splits after clause punctuation in the second half of a part", () => {
    const words = ["aaaa", "bbbb,", "cccc", "dddd", "eeee", "ffff"];
    // 20 characters at most: "aaaa bbbb, cccc dddd" is 20, the comma ends at 10.
    expect(splitWordsForSynthesis(words, 20)).toEqual([
      [0, 2],
      [2, 6],
    ]);
  });

  it("splits at a word when there is no punctuation, and covers every word", () => {
    const words = Array.from({ length: 200 }, (_, index) => `word${index}`);
    const ranges = splitWordsForSynthesis(words);

    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges[0][0]).toBe(0);
    expect(ranges.at(-1)?.[1]).toBe(200);
    for (const [index, [start, end]] of ranges.entries()) {
      if (index > 0) expect(start).toBe(ranges[index - 1][1]);
      expect(words.slice(start, end).join(" ").length).toBeLessThanOrEqual(350);
    }
  });
});
