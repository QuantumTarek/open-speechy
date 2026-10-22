import type { Lang, SentencePlan, TextPiece } from "../engines/types";
import { mapTextOffsets, type TextBlock } from "./extract";
import { normalizeEnglishWord } from "./normalize-en";

interface SegmentLike {
  segment: string;
  index: number;
}

const EN_SPECIAL_TOKENS =
  /(?:https?:\/\/|www\.)[^\s<>]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[A-Za-z]{2,}|[$€£]\s?-?\d[\d,]*(?:\.\d+)?|-?\d[\d,]*(?:\.\d+)?(?:st|nd|rd|th)?%?/giu;

function segmenter(
  locale: string,
  granularity: "sentence" | "word",
): Intl.Segmenter {
  return new Intl.Segmenter(locale, { granularity });
}

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
  const masked = text
    .replace(
      /\b(?:Dr|Mr|Mrs|Ms)\./giu,
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
      const words = rawWords.map((word, localIndex) => {
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
        const abbreviation = /^(?:dr|mr|mrs|ms)\.$/iu.test(display);
        return {
          index: wordIndex++,
          display,
          spoken:
            lang === "en"
              ? normalizeEnglishWord(abbreviation ? display : word.segment)
              : [word.segment],
          pieces: trimPieceRanges(block.pieces, wordStart, wordEnd),
        };
      });

      if (words.length === 0) continue;
      sentences.push({
        id: `sentence-${sentences.length}`,
        index: sentences.length,
        paragraphIndex,
        lang,
        text: sentenceText,
        spokenText: words.flatMap((word) => word.spoken).join(" "),
        words,
      });
    }
  });

  return sentences;
}
