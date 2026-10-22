import type { Lang, WordTiming } from "./types";

export interface TimingWord {
  wordIndex: number;
  text: string;
}

function isLetterOrNumber(char: string, lang: Lang): boolean {
  if (lang === "ar" && /\p{M}/u.test(char)) return false;
  return /[\p{L}\p{N}]/u.test(char);
}

function wordWeight(text: string, lang: Lang): number {
  const letters = Array.from(text).filter((char) =>
    isLetterOrNumber(char, lang),
  );
  const punctuation = text.match(/[,.?!،؛؟]+$/u)?.[0] ?? "";
  const punctuationWeight = Array.from(punctuation).reduce(
    (weight, char) =>
      weight + (",،".includes(char) ? 2 : ".?!؛؟".includes(char) ? 4 : 0),
    0,
  );
  return Math.max(1, letters.length) + punctuationWeight;
}

function activeAudioBounds(audio: Float32Array, sampleRate: number) {
  const threshold = 0.01;
  const windowSize = Math.max(1, Math.floor(sampleRate * 0.01));
  let firstActive = -1;
  let lastActive = -1;

  for (let start = 0; start < audio.length; start += windowSize) {
    const end = Math.min(audio.length, start + windowSize);
    let sum = 0;
    for (let index = start; index < end; index += 1) {
      sum += audio[index] * audio[index];
    }
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    if (rms >= threshold) {
      if (firstActive < 0) firstActive = start;
      lastActive = end;
    }
  }

  return firstActive < 0
    ? { start: 0, end: audio.length }
    : { start: firstActive, end: lastActive };
}

export function estimateWordTimings(
  words: TimingWord[],
  audio: Float32Array,
  sampleRate: number,
  lang: Lang,
): WordTiming[] {
  if (words.length === 0 || sampleRate <= 0) return [];

  const bounds = activeAudioBounds(audio, sampleRate);
  const startMs = (bounds.start / sampleRate) * 1_000;
  const endMs = (bounds.end / sampleRate) * 1_000;
  const durationMs = Math.max(0, endMs - startMs);
  const weights = words.map((word) => wordWeight(word.text, lang));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  let elapsedMs = startMs;

  return words.map((word, index) => {
    const start = elapsedMs;
    elapsedMs +=
      index === words.length - 1
        ? endMs - elapsedMs
        : (durationMs * weights[index]) / totalWeight;
    return {
      wordIndex: word.wordIndex,
      startMs: start,
      endMs: elapsedMs,
    };
  });
}

export function timingForWord(
  timings: WordTiming[],
  positionMs: number,
): WordTiming | undefined {
  let low = 0;
  let high = timings.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const timing = timings[middle];
    if (positionMs < timing.startMs) high = middle - 1;
    else if (positionMs >= timing.endMs) low = middle + 1;
    else return timing;
  }

  return timings[Math.min(low, timings.length - 1)];
}
