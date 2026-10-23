import { describe, expect, it } from "vitest";
import {
  ArabicDiacritizer,
  prepareTashkeelInput,
  isMostlyDiacritized,
  preserveWordOffsets,
  restoreTashkeel,
} from "../../src/engines/diacritizer";
import { normalizeArabicWord } from "../../src/text/normalize-ar";
import { numberToArabicWords } from "../../src/text/number-to-words-ar";
import { segmentBlocks } from "../../src/text/segment";
import type { TextBlock } from "../../src/text/extract";

function blockFromText(text: string): TextBlock {
  const node = document.createTextNode(text);
  return {
    text,
    pieces: [{ node, start: 0, end: node.length, offset: 0 }],
    element: null,
  };
}

describe("Arabic number expansion", () => {
  it.each([
    [0, "صفر"],
    [1, "واحد"],
    [2, "اثنان"],
    [3, "ثلاثة"],
    [4, "أربعة"],
    [5, "خمسة"],
    [6, "ستة"],
    [7, "سبعة"],
    [8, "ثمانية"],
    [9, "تسعة"],
    [10, "عشرة"],
    [11, "أحد عشر"],
    [12, "اثنا عشر"],
    [13, "ثلاثة عشر"],
    [14, "أربعة عشر"],
    [15, "خمسة عشر"],
    [16, "ستة عشر"],
    [17, "سبعة عشر"],
    [18, "ثمانية عشر"],
    [19, "تسعة عشر"],
    [20, "عشرون"],
    [21, "واحد وعشرون"],
    [22, "اثنان وعشرون"],
    [23, "ثلاثة وعشرون"],
    [24, "أربعة وعشرون"],
    [25, "خمسة وعشرون"],
    [26, "ستة وعشرون"],
    [27, "سبعة وعشرون"],
    [28, "ثمانية وعشرون"],
    [29, "تسعة وعشرون"],
    [30, "ثلاثون"],
    [31, "واحد وثلاثون"],
    [32, "اثنان وثلاثون"],
    [33, "ثلاثة وثلاثون"],
    [34, "أربعة وثلاثون"],
    [35, "خمسة وثلاثون"],
    [36, "ستة وثلاثون"],
    [37, "سبعة وثلاثون"],
    [38, "ثمانية وثلاثون"],
    [39, "تسعة وثلاثون"],
    [40, "أربعون"],
    [41, "واحد وأربعون"],
    [42, "اثنان وأربعون"],
    [43, "ثلاثة وأربعون"],
    [44, "أربعة وأربعون"],
    [45, "خمسة وأربعون"],
    [46, "ستة وأربعون"],
    [47, "سبعة وأربعون"],
    [48, "ثمانية وأربعون"],
    [49, "تسعة وأربعون"],
  ])("converts %i to %s", (value, expected) => {
    expect(numberToArabicWords(value)).toBe(expected);
  });

  it("handles hundreds, scales, negatives, and the documented limit", () => {
    expect(numberToArabicWords(101)).toBe("مئة وواحد");
    expect(numberToArabicWords(200)).toBe("مئتان");
    expect(numberToArabicWords(999)).toBe("تسعمئة وتسعة وتسعون");
    expect(numberToArabicWords(1_000)).toBe("ألف");
    expect(numberToArabicWords(2_000)).toBe("ألفان");
    expect(numberToArabicWords(3_000)).toBe("ثلاثة آلاف");
    expect(numberToArabicWords(11_000)).toBe("أحد عشر ألفًا");
    expect(numberToArabicWords(1_000_000)).toBe("مليون");
    expect(numberToArabicWords(2_000_000)).toBe("مليونان");
    expect(numberToArabicWords(3_000_000)).toBe("ثلاثة ملايين");
    expect(numberToArabicWords(-14)).toBe("سالب أربعة عشر");
    expect(() => numberToArabicWords(1_000_000_000)).toThrow(RangeError);
  });
});

describe("Arabic normalization", () => {
  it("removes tatweel and expands Arabic-Indic and Persian digits", () => {
    expect(normalizeArabicWord("السـلام")).toEqual(["السلام"]);
    expect(normalizeArabicWord("١٢")).toEqual(["اثنا", "عشر"]);
    expect(normalizeArabicWord("۱۲")).toEqual(["اثنا", "عشر"]);
  });

  it("expands decimals, percentages, and currency while keeping harakat", () => {
    expect(normalizeArabicWord("٣٫١٤")).toEqual([
      "ثلاثة",
      "فاصلة",
      "واحد",
      "أربعة",
    ]);
    expect(normalizeArabicWord("3.14")).toEqual([
      "ثلاثة",
      "فاصلة",
      "واحد",
      "أربعة",
    ]);
    expect(normalizeArabicWord("٥٠٪")).toEqual(["خمسون", "بالمئة"]);
    expect(normalizeArabicWord("$١٠")).toEqual(["عشرة", "دولار"]);
    expect(normalizeArabicWord("مَرْحَبًا")).toEqual(["مَرْحَبًا"]);
  });

  it("keeps Arabic-script numbers and currency together during segmentation", () => {
    const sentences = segmentBlocks(
      [blockFromText("عام ٢٠٢٤، بلغت النسبة ٥٠٪. السعر $١٠.٥٠.")],
      () => "ar",
    );
    const spoken = sentences.flatMap((sentence) =>
      sentence.words.flatMap((word) => word.spoken),
    );

    expect(spoken).toContain("ألفان");
    expect(spoken).toContain("وأربعة");
    expect(spoken).toContain("بالمئة.");
    expect(spoken).toContain("دولار");
    expect(spoken).toContain("سنت.");
  });
});

describe("Arabic diacritization fallback", () => {
  const maps = {
    input: { _: 0, " ": 1, "#": 2, ب: 3, س: 4, م: 5 },
    hint: { _: 0, "": 1, "ِ": 7, "ْ": 14 },
    target: { _: 0, "": 1, "ِ": 7, "ْ": 14 },
  };

  it("encodes marks as hints attached to their preceding Arabic letter", () => {
    const prepared = prepareTashkeelInput("بِسْم", maps);

    expect(prepared.inputIds).toEqual([3n, 4n, 5n]);
    expect(prepared.hintIds).toEqual([7n, 14n, 1n]);
    expect(prepared.cleanLength).toBe(3);
  });

  it("reapplies model marks without changing unsupported characters", () => {
    const prepared = prepareTashkeelInput("بx", maps);

    expect(
      restoreTashkeel("بx", [7], maps, prepared.removedCharacters),
    ).toBe("بِx");
  });

  it("detects text that already has harakat", () => {
    expect(isMostlyDiacritized("مَرْحَبًا بِكَ")).toBe(true);
    expect(isMostlyDiacritized("مرحبا بك")).toBe(false);
  });

  it("keeps source word boundaries when the predictor changes its output", () => {
    const words = ["هذا", "كتاب"];
    expect(preserveWordOffsets(words, "هٰذَا كِتَابٌ")).toEqual([
      "هٰذَا",
      "كِتَابٌ",
    ]);
    expect(preserveWordOffsets(words, "هٰذَا كِتَابٌ جديد")).toBe(words);
  });

  it("leaves diacritization disabled without a verified predictor", async () => {
    const predictor = async () => "هٰذَا كِتَابٌ";
    const disabled = new ArabicDiacritizer(false, predictor);
    const enabledWithoutModel = new ArabicDiacritizer(true);

    expect(await disabled.apply(["هذا", "كتاب"])).toEqual(["هذا", "كتاب"]);
    expect(await enabledWithoutModel.apply(["هذا", "كتاب"])).toEqual([
      "هذا",
      "كتاب",
    ]);
  });
});

describe("mixed-script sentence runs", () => {
  it("switches engines for multiword script runs and keeps one foreign word local", () => {
    const sentences = segmentBlocks(
      [
        blockFromText("مرحبا بالعالم Open Speechy اليوم مرحبا بالعالم."),
      ],
      () => "ar",
    );

    expect(sentences.map((sentence) => sentence.lang)).toEqual([
      "ar",
      "en",
      "ar",
    ]);
    expect(sentences.flatMap((sentence) => sentence.words).map((word) => word.index))
      .toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
