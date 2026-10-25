import type { Lang, SentencePlan, TextPiece } from "../engines/types";
import { mapTextOffsets, type TextBlock } from "./extract";
import { splitMixedScriptRuns } from "./lang";
import { normalizeArabicWord } from "./normalize-ar";
import {
  DOMAIN_TLDS,
  normalizeEnglishWord,
  type UrlSpeechPolicy,
} from "./normalize-en";

interface SegmentLike {
  segment: string;
  index: number;
}

// Matched in this order: links, email, dates, times and number runs before
// plain numbers, so "2024-03-06" is one date rather than three numbers. A
// minus sign counts only when no letter or digit comes right before it.
const EN_SPECIAL_TOKENS = new RegExp(
  [
    String.raw`(?:https?:\/\/|www\.)[^\s<>]+`,
    String.raw`[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}`,
    String.raw`(?<![\p{L}\p{N}@.])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:${DOMAIN_TLDS})(?![\p{L}\p{N}])(?:\/[^\s<>]*)?`,
    String.raw`(?<![\p{N}])\d{4}[-/]\d{1,2}[-/]\d{1,2}(?![\p{N}])`,
    String.raw`(?<![\p{N}])\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})(?![\p{N}])`,
    String.raw`(?<![\p{N}])\d{1,2}:\d{2}(?![\p{N}])(?:\s?[ap]\.?m\.?(?![\p{L}]))?`,
    String.raw`(?<![\p{L}\p{N}-])\d[\d,]*(?:\.\d+)?(?:[-–]\d[\d,]*(?:\.\d+)?)+%?(?![\p{L}\p{N}])`,
    String.raw`[$€£]\s?-?\d[\d,]*(?:\.\d+)?`,
    String.raw`(?<![\p{L}\p{N}])-?\d[\d,]*(?:\.\d+)?(?:st|nd|rd|th)?%?`,
  ].join("|"),
  "giu",
);
const AR_DIGIT = "[\\d٠-٩۰-۹]";
const AR_SPECIAL_TOKENS = new RegExp(
  [
    String.raw`(?<!${AR_DIGIT})${AR_DIGIT}{4}[-/]${AR_DIGIT}{1,2}[-/]${AR_DIGIT}{1,2}(?!${AR_DIGIT})`,
    String.raw`(?<![\p{L}\p{N}-])${AR_DIGIT}+(?:[-–]${AR_DIGIT}+)+(?![\p{L}\p{N}])`,
    String.raw`[$€£]\s?-?${AR_DIGIT}[\d٠-٩۰-۹,٬]*(?:[.٫]${AR_DIGIT}+)?[%٪]?`,
    String.raw`(?<![\p{L}\p{N}])-?${AR_DIGIT}[\d٠-٩۰-۹,٬]*(?:[.٫]${AR_DIGIT}+)?[%٪]?`,
  ].join("|"),
  "giu",
);

// Periods that do not end a sentence. Titles always; months and "No." only
// before a number.
const ABBREVIATION_PERIOD =
  /\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|Mt|Ft|Gen|Col|Lt|Sgt|Capt|Gov|Sen|Rep|Rev|Hon|vs)\.|\b(?:No|Nos|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.(?=\s*\d)/gu;
const ABBREVIATION_WORD =
  /^(?:dr|mr|mrs|ms|prof|sr|jr|st|mt|ft|gen|col|lt|sgt|capt|gov|sen|rep|rev|hon|vs|e\.g|i\.e|etc)\.$/iu;
// Initialisms such as "U.S.": their periods are not pauses.
const INITIALISM = /^(?:\p{L}\.){2,}$/u;
const NUMBER_ABBREVIATION_WORD =
  /^(?:no|nos|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.$/iu;
// Punctuation passed on to the voice, which uses it for pauses and intonation.
const SPOKEN_PUNCTUATION = /[,.;:!?…—،؛؟]/gu;
// Line breaks other than a blank line. Page markup and pasted text wrap lines
// inside sentences, and the segmenter would end a sentence at each one.
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/gu;

function segmenter(
  locale: string,
  granularity: "sentence" | "word",
): Intl.Segmenter {
  return new Intl.Segmenter(locale, { granularity });
}

// Long sentences are read in clauses, so the first audio is not held up and
// each part stays within what the in-browser voices take at once.
function splitLongSentence(sentence: SegmentLike): SegmentLike[] {
  if (sentence.segment.length <= 300) return [sentence];
  const chunks: SegmentLike[] = [];
  const delimiter = /[,;،؛]\s+/gu;
  let offset = 0;
  let match: RegExpExecArray | null;
  while ((match = delimiter.exec(sentence.segment))) {
    const end = match.index + match[0].length;
    if (end - offset >= 200) {
      chunks.push({
        segment: sentence.segment.slice(offset, end),
        index: sentence.index + offset,
      });
      offset = end;
    }
  }
  if (offset < sentence.segment.length) {
    chunks.push({
      segment: sentence.segment.slice(offset),
      index: sentence.index + offset,
    });
  }
  return chunks.length > 1 ? chunks : [sentence];
}

function sentenceWordSegments(text: string, lang: Lang): SegmentLike[] {
  const locale = lang === "ar" ? "ar" : "en";
  const ordinary = Array.from(segmenter(locale, "word").segment(text))
    .filter((part) => part.isWordLike)
    .map((part) => ({ segment: part.segment, index: part.index }));
  if (lang === "ar") {
    const special = Array.from(text.matchAll(AR_SPECIAL_TOKENS))
      .map((match) => ({
        segment: match[0].replace(/[.,!?;:،؛؟]+$/u, ""),
        index: match.index,
      }))
      .filter((word) => word.segment);
    return [
      ...ordinary.filter((word) => {
        const end = word.index + word.segment.length;
        return !special.some(
          (token) =>
            word.index < token.index + token.segment.length &&
            end > token.index,
        );
      }),
      ...special,
    ].sort((left, right) => left.index - right.index);
  }
  if (lang !== "en") return ordinary;

  const special: SegmentLike[] = [];
  for (const match of text.matchAll(EN_SPECIAL_TOKENS)) {
    const segment = match[0].replace(/[.,!?;:]+$/u, "");
    if (segment) special.push({ segment, index: match.index });
  }

  return [
    ...ordinary.filter((word) => {
      const end = word.index + word.segment.length;
      return !special.some(
        (token) =>
          word.index < token.index + token.segment.length && end > token.index,
      );
    }),
    ...special,
  ].sort((left, right) => left.index - right.index);
}

function sentenceSegments(text: string, lang: Lang): SegmentLike[] {
  // Every replacement keeps the length, so offsets still match the text.
  const masked = text
    .replace(/\s+/gu, (space) =>
      /\n[^\S\n]*\n/u.test(space) ? space : space.replace(LINE_BREAK, " "),
    )
    .replace(
      ABBREVIATION_PERIOD,
      (match) => `${match.slice(0, -1)}\uE000`,
    )
    .replace(/\b(?:e\.g|i\.e|etc)\./giu, (match) =>
      match.replaceAll(".", "\uE000"),
    )
    .replace(/؟/gu, ".");

  return Array.from(
    segmenter(lang === "ar" ? "ar" : "en", "sentence").segment(masked),
  ).map((part) => ({
    segment: text.slice(part.index, part.index + part.segment.length),
    index: part.index,
  }));
}

function trimPieceRanges(
  pieces: TextPiece[],
  start: number,
  end: number,
): TextPiece[] {
  return mapTextOffsets(pieces, start, end);
}

export function segmentBlocks(
  blocks: TextBlock[],
  langForBlock: (block: TextBlock) => Lang,
  firstWordIndex = 0,
  options: { urlPolicy?: UrlSpeechPolicy } = {},
): SentencePlan[] {
  const sentences: SentencePlan[] = [];
  let wordIndex = firstWordIndex;

  blocks.forEach((block, paragraphIndex) => {
    const lang = langForBlock(block);
    const rawSentences = sentenceSegments(block.text, lang);

    for (const rawSentence of rawSentences.flatMap(splitLongSentence)) {
      const leadingTrim =
        rawSentence.segment.length - rawSentence.segment.trimStart().length;
      const sentenceText = rawSentence.segment.trim();
      if (!sentenceText) continue;
      const sourceStart = rawSentence.index + leadingTrim;
      const rawWords = sentenceWordSegments(sentenceText, lang);
      const runs = splitMixedScriptRuns(
        rawWords.map((word) => ({ text: word.segment, lang })),
        lang,
      );
      let rawWordIndex = 0;
      for (const run of runs) {
        const runLang = run[0]?.lang ?? lang;
        const words = run.map(() => {
          const localIndex = rawWordIndex++;
          const word = rawWords[localIndex];
          const nextWord = rawWords[localIndex + 1];
          const trailing = sentenceText.slice(
            word.index + word.segment.length,
            nextWord?.index ?? sentenceText.length,
          );
          const punctuation =
            trailing.trimStart().match(/^[^\p{L}\p{N}\s]+/u)?.[0] ?? "";
          const display = `${word.segment}${punctuation}`;
          const wordStart = sourceStart + word.index;
          const wordEnd = wordStart + word.segment.length;
          const abbreviation =
            ABBREVIATION_WORD.test(display) ||
            INITIALISM.test(display) ||
            (NUMBER_ABBREVIATION_WORD.test(display) &&
              /^\d/u.test(nextWord?.segment ?? ""));
          const spoken =
            runLang === "en"
              ? normalizeEnglishWord(
                  abbreviation ? display : word.segment,
                  options.urlPolicy,
                )
              : normalizeArabicWord(word.segment);
          const pause = abbreviation
            ? ""
            : (punctuation.match(SPOKEN_PUNCTUATION) ?? []).join("");
          return {
            index: wordIndex++,
            display,
            spoken:
              pause && spoken.length > 0
                ? [...spoken.slice(0, -1), `${spoken.at(-1)}${pause}`]
                : spoken,
            pieces: trimPieceRanges(block.pieces, wordStart, wordEnd),
          };
        });

        if (words.length === 0) continue;
        sentences.push({
          id: `sentence-${sentences.length}`,
          index: sentences.length,
          paragraphIndex,
          lang: runLang,
          text: words.map((word) => word.display).join(" "),
          spokenText: words.flatMap((word) => word.spoken).join(" "),
          words,
        });
      }
    }
  });

  return sentences;
}
