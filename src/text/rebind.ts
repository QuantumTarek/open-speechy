import type { SentencePlan } from "../engines/types";

function wordKey(value: string): string {
  return value
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function rebindSentencePieces(
  original: SentencePlan[],
  refreshed: SentencePlan[],
): SentencePlan[] {
  const newWords = refreshed.flatMap((sentence) => sentence.words);
  const positions = new Map<string, number[]>();
  newWords.forEach((word, index) => {
    const key = wordKey(word.display);
    if (!key) return;
    const matches = positions.get(key) ?? [];
    matches.push(index);
    positions.set(key, matches);
  });

  let cursor = 0;
  return original.map((sentence) => ({
    ...sentence,
    words: sentence.words.map((word) => {
      const key = wordKey(word.display);
      const matches = positions.get(key);
      const position = matches?.find((index) => index >= cursor);
      if (position === undefined) return { ...word, pieces: [] };
      cursor = position + 1;
      return { ...word, pieces: newWords[position].pieces };
    }),
  }));
}
