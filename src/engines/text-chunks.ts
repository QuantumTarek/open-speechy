// Kokoro reads at most 510 phoneme tokens at once and drops the rest of the
// text, which cut long sentences short. About 350 characters stays under it.
export const KOKORO_MAX_CHUNK_CHARS = 350;

const CLAUSE_END = /[,;:—.!?…]$/u;

/**
 * Splits words into [start, end) ranges whose text fits in maxChars. A range
 * ends after clause punctuation when one falls in its second half, so the
 * voice pauses where a reader would.
 */
export function splitWordsForSynthesis(
  words: string[],
  maxChars = KOKORO_MAX_CHUNK_CHARS,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  while (start < words.length) {
    let end = start;
    let length = 0;
    let clauseEnd = -1;
    while (end < words.length) {
      const next = length + (end > start ? 1 : 0) + words[end].length;
      if (next > maxChars && end > start) break;
      length = next;
      end += 1;
      if (CLAUSE_END.test(words[end - 1]) && length >= maxChars / 2) {
        clauseEnd = end;
      }
    }
    if (end < words.length && clauseEnd > start) end = clauseEnd;
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}
