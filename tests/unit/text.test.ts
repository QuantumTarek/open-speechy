import { describe, expect, it } from "vitest";
import type { TextPiece } from "../../src/engines/types";
import {
  extractSelectionBlocks,
  extractTextBlocks,
  mapTextOffsets,
  type TextBlock,
} from "../../src/text/extract";
import { detectLanguage, splitMixedScriptRuns } from "../../src/text/lang";
import { normalizeEnglishWord } from "../../src/text/normalize-en";
import { numberToEnglish } from "../../src/text/number-to-words-en";
import { segmentBlocks } from "../../src/text/segment";

function blockFromText(text: string): TextBlock {
  const node = document.createTextNode(text);
  return {
    text,
    pieces: [{ node, start: 0, end: text.length, offset: 0 }],
    element: null,
  };
}

describe("article text extraction", () => {
  it("keeps visible prose and preserves inline text-node offsets", () => {
    const root = document.createElement("article");
    root.innerHTML = [
      "<nav>navigation text</nav>",
      "<p>Hello <strong>world</strong>.</p>",
      "<p hidden>hidden paragraph</p>",
      '<p style="display: none">display-hidden text</p>',
      "<pre>code sample</pre>",
      "<script>script text</script>",
    ].join("");

    const blocks = extractTextBlocks(root);

    expect(blocks.map((block) => block.text)).toEqual(["Hello world."]);
    expect(
      mapTextOffsets(blocks[0].pieces, 6, 11).map((piece) =>
        piece.node.data.slice(piece.start, piece.end),
      ),
    ).toEqual(["world"]);
  });

  it("clips each selected range to the selected characters", () => {
    const root = document.createElement("p");
    root.innerHTML = "Start <b>middle</b> end";
    const first = root.firstChild as Text;
    const last = root.querySelector("b")?.firstChild as Text;
    const selection = document.getSelection();
    const range = document.createRange();
    range.setStart(first, 2);
    range.setEnd(last, 3);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const blocks = extractSelectionBlocks(selection as Selection);

    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("art mid");
    expect(blocks[0].pieces).toEqual([
      expect.objectContaining({ node: first, start: 2, end: 6, offset: 0 }),
      expect.objectContaining({ node: last, start: 0, end: 3, offset: 4 }),
    ]);
    selection?.removeAllRanges();
  });
});

describe("English number normalization", () => {
  it.each([
    [0, "zero"],
    [1, "one"],
    [2, "two"],
    [3, "three"],
    [4, "four"],
    [5, "five"],
    [6, "six"],
    [7, "seven"],
    [8, "eight"],
    [9, "nine"],
    [10, "ten"],
    [11, "eleven"],
    [12, "twelve"],
    [13, "thirteen"],
    [14, "fourteen"],
    [15, "fifteen"],
    [16, "sixteen"],
    [17, "seventeen"],
    [18, "eighteen"],
    [19, "nineteen"],
    [20, "twenty"],
    [21, "twenty-one"],
    [22, "twenty-two"],
    [23, "twenty-three"],
    [24, "twenty-four"],
    [25, "twenty-five"],
    [26, "twenty-six"],
    [27, "twenty-seven"],
    [28, "twenty-eight"],
    [29, "twenty-nine"],
    [30, "thirty"],
    [31, "thirty-one"],
    [32, "thirty-two"],
    [33, "thirty-three"],
    [34, "thirty-four"],
    [35, "thirty-five"],
    [36, "thirty-six"],
    [37, "thirty-seven"],
    [38, "thirty-eight"],
    [39, "thirty-nine"],
    [40, "forty"],
    [41, "forty-one"],
    [42, "forty-two"],
    [43, "forty-three"],
    [44, "forty-four"],
    [45, "forty-five"],
    [46, "forty-six"],
    [47, "forty-seven"],
    [48, "forty-eight"],
    [49, "forty-nine"],
  ])("converts %i to %s", (value, expected) => {
    expect(numberToEnglish(value)).toBe(expected);
  });

  it("expands decimals, percentages, years, ordinals, currency, and abbreviations", () => {
    expect(normalizeEnglishWord("3.14")).toEqual([
      "three",
      "point",
      "one",
      "four",
    ]);
    expect(normalizeEnglishWord("3.14%")).toEqual([
      "three",
      "point",
      "one",
      "four",
      "percent",
    ]);
    expect(normalizeEnglishWord("2024")).toEqual(["twenty", "twenty-four"]);
    expect(normalizeEnglishWord("1905")).toEqual(["nineteen", "oh", "five"]);
    expect(normalizeEnglishWord("21st")).toEqual(["twenty-first"]);
    expect(normalizeEnglishWord("$1,234.50")).toEqual([
      "one",
      "thousand",
      "two",
      "hundred",
      "thirty-four",
      "dollars",
      "and",
      "fifty",
      "cents",
    ]);
    expect(normalizeEnglishWord("e.g.")).toEqual(["for", "example"]);
  });

  it("speaks only the domain of URLs and email addresses by default", () => {
    expect(normalizeEnglishWord("https://www.example.com/a?q=1")).toEqual([
      "example",
      "dot",
      "com",
    ]);
    expect(normalizeEnglishWord("reader@example.org")).toEqual([
      "example",
      "dot",
      "org",
    ]);
    expect(normalizeEnglishWord("https://example.com", "skip")).toEqual([]);
    expect(normalizeEnglishWord("https://example.com", "full")).toEqual([
      "https://example.com",
    ]);
  });
});

describe("sentence and word segmentation", () => {
  it("keeps abbreviations and decimals together and attaches punctuation", () => {
    const sentences = segmentBlocks(
      [blockFromText("Dr. Smith paid $1,234.50. The rate was 3.14%.")],
      () => "en",
    );

    expect(sentences).toHaveLength(2);
    expect(sentences[0].words.map((word) => word.display)).toEqual([
      "Dr.",
      "Smith",
      "paid",
      "$1,234.50.",
    ]);
    expect(sentences[0].words[3].spoken).toEqual([
      "one",
      "thousand",
      "two",
      "hundred",
      "thirty-four",
      "dollars",
      "and",
      "fifty",
      "cents",
    ]);
    expect(sentences[1].words[3].spoken).toEqual([
      "three",
      "point",
      "one",
      "four",
      "percent",
    ]);
    expect(sentences[0].words[1].display).toBe("Smith");
  });

  it("segments Arabic punctuation and maintains global word indexes", () => {
    const sentences = segmentBlocks(
      [blockFromText("مرحبا بالعالم، كيف حالك؟ نعم.")],
      () => "ar",
      8,
    );

    expect(sentences).toHaveLength(2);
    expect(sentences[0].words.map((word) => word.index)).toEqual([
      8, 9, 10, 11,
    ]);
    expect(sentences[0].words[1].display).toBe("بالعالم،");
    expect(sentences[0].words.at(-1)?.display).toBe("حالك؟");
    expect(sentences[1].words.at(-1)?.display).toBe("نعم.");
  });

  it("maps source pieces to their original word offsets", () => {
    const first = document.createTextNode("The ");
    const second = document.createTextNode("quick brown fox.");
    const pieces: TextPiece[] = [
      { node: first, start: 0, end: first.length, offset: 0 },
      { node: second, start: 0, end: second.length, offset: first.length },
    ];
    const sentence = segmentBlocks(
      [{ text: "The quick brown fox.", pieces, element: null }],
      () => "en",
    )[0];

    expect(sentence.words[1].pieces).toEqual([
      expect.objectContaining({ node: second, start: 0, end: 5, offset: 4 }),
    ]);
    expect(sentence.words[3].pieces[0].node).toBe(second);
    expect(sentence.words[3].pieces[0].end).toBe(15);
  });
});

describe("language detection", () => {
  it("uses script share and declared language for short text", () => {
    expect(detectLanguage("هذا مقال باللغة العربية")).toBe("ar");
    expect(detectLanguage("A mixed text العربية")).toBe("en");
    expect(detectLanguage("123", "ar-SA")).toBe("ar");
    expect(detectLanguage("Hello", "ar")).toBe("en");
  });

  it("keeps a one-word foreign run in the paragraph language", () => {
    const runs = splitMixedScriptRuns(
      [
        { text: "مرحبا", lang: "ar" as const },
        { text: "بالعالم", lang: "ar" as const },
        { text: "Open", lang: "en" as const },
        { text: "بالعالم", lang: "ar" as const },
      ],
      "ar",
    );

    expect(runs).toHaveLength(1);
    expect(runs[0].map((word) => word.lang)).toEqual(["ar", "ar", "ar", "ar"]);
  });
});
