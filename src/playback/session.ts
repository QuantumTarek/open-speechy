import type {
  Lang,
  SynthesisRequest,
  SynthesisResult,
  TtsEngine,
  WordTiming,
} from "../engines/types";
import { timingForWord } from "../engines/timings";
import type { AudioScheduler, ScheduledAudio } from "./audio-player";

export interface PlayableWord {
  index: number;
  display: string;
  spoken: string[];
}

export interface PlayableSentence {
  id: string;
  index: number;
  paragraphIndex: number;
  lang: Lang;
  text: string;
  words: PlayableWord[];
}

// "buffering" means playback ran out of audio while the next sentence is
// still being synthesized.
export type SessionState =
  | "idle"
  | "loading"
  | "playing"
  | "buffering"
  | "paused"
  | "ended"
  | "error";

export interface SessionCallbacks {
  onState(state: SessionState, error?: string): void;
  onSentenceStart(event: {
    sentenceId: string;
    sentenceIndex: number;
    timings: WordTiming[];
    timingSource: SynthesisResult["timingSource"];
    durationMs: number;
    rate: number;
    startedAtPerf: number;
    // Increases on every seek or restart. Earlier segments are stale.
    generation: number;
  }): void;
}

interface ScheduledSentence extends ScheduledAudio {
  sentenceIndex: number;
  timings: WordTiming[];
}

interface HeldSentence {
  sentenceIndex: number;
  result: SynthesisResult;
}

export interface SessionBufferOptions {
  // Synthesis runs ahead until this much audio is queued, so a slow sentence
  // is ready before the one playing ends.
  bufferSeconds?: number;
  maxBufferedSentences?: number;
}

const DEFAULT_BUFFER_SECONDS = 30;
const DEFAULT_MAX_BUFFERED_SENTENCES = 12;
const MIN_BUFFERED_SENTENCES = 2;
// Before playback starts, and after it runs dry, audio is held until it lasts
// longer than the next sentence is expected to take to synthesize. Otherwise
// a short heading followed by a long sentence leaves a silence between them.
const PREBUFFER_MARGIN = 1.2;
const MAX_PREBUFFER_SECONDS = 12;
// Estimates used until the session has measured its engine.
const DEFAULT_REALTIME_FACTOR = 1;
const DEFAULT_SECONDS_PER_WORD = 0.35;
// Finished sentences kept so next, previous and resume after a seek do not
// synthesize them again.
const RESULT_CACHE_SIZE = 32;

export class SessionQueue {
  readonly #engine: TtsEngine;
  readonly #audio: AudioScheduler;
  readonly #callbacks: SessionCallbacks;
  readonly #bufferSeconds: number;
  readonly #maxBufferedSentences: number;
  readonly #results = new Map<string, SynthesisResult>();
  // Engines run one synthesis at a time. A seek waits for the cancelled one.
  #synthesisChain: Promise<unknown> = Promise.resolve();
  #sentences: PlayableSentence[] = [];
  #scheduled: ScheduledSentence[] = [];
  #held: HeldSentence[] = [];
  // Synthesis seconds per audio second, and audio seconds per word at 1x.
  #realtimeFactor: number | null = null;
  #secondsPerWord: number | null = null;
  #measuredSyntheses = 0;
  #generation = 0;
  #nextIndex = 0;
  #firstWordIndex: number | null = null;
  #scheduledCount = 0;
  #controller: AbortController | null = null;
  #fillTask: Promise<void> | null = null;
  #nextAudioTime = 0;
  #speed = 1;
  #playing = false;
  #state: SessionState = "idle";
  #voiceId = "kokoro:af_heart";

  constructor(
    engine: TtsEngine,
    audio: AudioScheduler,
    callbacks: SessionCallbacks,
    options: SessionBufferOptions = {},
  ) {
    this.#engine = engine;
    this.#audio = audio;
    this.#callbacks = callbacks;
    this.#bufferSeconds = Math.max(
      0,
      options.bufferSeconds ?? DEFAULT_BUFFER_SECONDS,
    );
    this.#maxBufferedSentences = Math.max(
      MIN_BUFFERED_SENTENCES,
      options.maxBufferedSentences ?? DEFAULT_MAX_BUFFERED_SENTENCES,
    );
  }

  get state(): SessionState {
    return this.#state;
  }

  async start(
    sentences: PlayableSentence[],
    options: { startWordIndex?: number; voiceId?: string; speed?: number } = {},
  ): Promise<void> {
    this.#resetPlayback();
    this.#sentences = sentences;
    this.#voiceId = options.voiceId ?? this.#voiceId;
    this.#speed = Math.min(3, Math.max(0.5, options.speed ?? this.#speed));
    this.#firstWordIndex = options.startWordIndex ?? null;
    this.#nextIndex = this.#sentenceIndexForWord(
      this.#firstWordIndex ?? sentences[0]?.words[0]?.index ?? 0,
    );
    this.#nextAudioTime = this.#audio.currentTime + 0.02;

    if (sentences.length === 0 || this.#nextIndex >= sentences.length) {
      this.#setState("error", "No readable sentences were found.");
      return;
    }

    this.#setState("loading");
    await this.#startFromCurrent();
  }

  async pause(): Promise<void> {
    if (!this.#playing) return;
    this.#playing = false;
    this.#setState("paused");
    await this.#audio.suspend();
  }

  async resume(): Promise<void> {
    if (this.#playing || this.#sentences.length === 0) return;
    this.#playing = true;
    await this.#audio.resume();
    this.#setState(this.#scheduledCount > 0 ? "playing" : "buffering");
    await this.#fillQueue(this.#generation);
  }

  async toggle(): Promise<void> {
    if (this.#state === "paused") await this.resume();
    else if (this.#playing) await this.pause();
    else if (this.#state === "idle" || this.#state === "ended") {
      await this.start(this.#sentences);
    }
  }

  async next(): Promise<void> {
    const current = this.#currentSentenceIndex();
    const next =
      this.#sentences[Math.min(current + 1, this.#sentences.length - 1)];
    if (next) await this.seek(next.words[0]?.index ?? 0);
  }

  async previous(): Promise<void> {
    const current = this.#currentSentenceIndex();
    const schedule = this.#currentSchedule();
    const elapsedMs = schedule
      ? Math.max(0, (this.#audio.currentTime - schedule.startAt) * 1_000)
      : 0;
    const targetIndex = elapsedMs < 1_500 ? Math.max(0, current - 1) : current;
    const target = this.#sentences[targetIndex];
    if (target) await this.seek(target.words[0]?.index ?? 0);
  }

  async seek(wordIndex: number): Promise<void> {
    const sentenceIndex = this.#sentenceIndexForWord(wordIndex);
    if (sentenceIndex >= this.#sentences.length) return;
    const shouldResume = this.#playing || this.#state !== "paused";
    this.#resetPlayback();
    this.#nextIndex = sentenceIndex;
    this.#firstWordIndex = wordIndex;
    this.#nextAudioTime = this.#audio.currentTime + 0.02;
    if (shouldResume) await this.#startFromCurrent();
  }

  async setSpeed(speed: number): Promise<void> {
    const nextSpeed = Math.min(3, Math.max(0.5, speed));
    if (nextSpeed === this.#speed) return;
    const schedule = this.#currentSchedule();
    const sentence = this.#sentences[this.#currentSentenceIndex()];
    const elapsedMs = schedule
      ? Math.max(0, (this.#audio.currentTime - schedule.startAt) * 1_000)
      : 0;
    const currentTiming = schedule
      ? timingForWord(schedule.timings, elapsedMs)
      : undefined;
    const wordIndex = currentTiming?.wordIndex ?? sentence?.words[0]?.index;
    this.#speed = nextSpeed;
    if (wordIndex !== undefined) await this.seek(wordIndex);
  }

  async stop(): Promise<void> {
    this.#resetPlayback();
    this.#sentences = [];
    this.#setState("idle");
  }

  async dispose(): Promise<void> {
    await this.stop();
    this.#audio.stop();
    await this.#engine.dispose();
    await this.#audio.close();
  }

  async #startFromCurrent(): Promise<void> {
    try {
      await this.#engine.init();
      await this.#audio.resume();
      this.#playing = true;
      if (this.#state !== "loading") this.#setState("buffering");
      await this.#fillQueue(this.#generation);
    } catch (error) {
      this.#playing = false;
      this.#setState("error", errorMessage(error));
    }
  }

  async #fillQueue(generation: number): Promise<void> {
    if (this.#fillTask) return this.#fillTask;
    this.#fillTask = this.#fill(generation).finally(() => {
      this.#fillTask = null;
    });
    return this.#fillTask;
  }

  async #fill(generation: number): Promise<void> {
    this.#releaseHeld(generation);
    while (
      this.#playing &&
      generation === this.#generation &&
      this.#needsMoreAudio() &&
      this.#nextIndex < this.#sentences.length
    ) {
      const sentenceIndex = this.#nextIndex;
      const sentence = this.#sentences[sentenceIndex];
      const words = sentence.words.filter(
        (word) =>
          sentenceIndex !==
            this.#sentenceIndexForWord(
              this.#firstWordIndex ?? sentence.words[0]?.index ?? 0,
            ) ||
          this.#firstWordIndex === null ||
          word.index >= this.#firstWordIndex,
      );
      this.#firstWordIndex = null;
      if (words.length === 0) {
        this.#nextIndex += 1;
        continue;
      }

      const controller = new AbortController();
      this.#controller = controller;
      let result: SynthesisResult;
      try {
        result = await this.#synthesize(
          this.#requestFor(sentence, words),
          controller.signal,
        );
      } catch (error) {
        if (generation !== this.#generation || controller.signal.aborted)
          return;
        this.#playing = false;
        this.#setState("error", errorMessage(error));
        return;
      } finally {
        if (this.#controller === controller) this.#controller = null;
      }
      if (generation !== this.#generation) return;

      this.#nextIndex += 1;
      this.#held.push({ sentenceIndex, result });
      this.#releaseHeld(generation);
    }
  }

  // Schedules held audio, unless playback is stopped and there is not yet
  // enough of it to cover synthesis of the sentence after it.
  #releaseHeld(generation: number): void {
    if (this.#held.length === 0 || !this.#playing) return;
    if (this.#scheduledCount === 0 && !this.#enoughHeldToPlay()) return;
    const held = this.#held;
    this.#held = [];
    for (const { sentenceIndex, result } of held) {
      this.#schedule(sentenceIndex, result, generation);
    }
    if (this.#state === "loading" || this.#state === "buffering") {
      this.#setState("playing");
    }
  }

  #enoughHeldToPlay(): boolean {
    const next = this.#sentences[this.#nextIndex];
    if (!next || this.#held.length >= this.#maxBufferedSentences) return true;
    const heldSeconds = this.#held.reduce(
      (total, { result }) => total + result.audio.length / result.sampleRate,
      0,
    );
    const needed = Math.min(
      MAX_PREBUFFER_SECONDS,
      PREBUFFER_MARGIN * this.#predictedSynthesisSeconds(next),
    );
    return heldSeconds >= needed;
  }

  #predictedSynthesisSeconds(sentence: PlayableSentence): number {
    const factor = this.#realtimeFactor ?? DEFAULT_REALTIME_FACTOR;
    const perWord = this.#secondsPerWord ?? DEFAULT_SECONDS_PER_WORD;
    return (factor * sentence.words.length * perWord) / this.#speed;
  }

  #schedule(
    sentenceIndex: number,
    result: SynthesisResult,
    generation: number,
  ): void {
    const sentence = this.#sentences[sentenceIndex];
    const startAt = Math.max(
      this.#nextAudioTime,
      this.#audio.currentTime + 0.02,
    );
    this.#scheduledCount += 1;
    const scheduled = this.#audio.schedule(result, startAt, () => {
      if (generation !== this.#generation) return;
      this.#scheduledCount = Math.max(0, this.#scheduledCount - 1);
      this.#scheduled = this.#scheduled.filter(
        (item) => item.sentenceIndex !== sentenceIndex,
      );
      if (
        this.#scheduledCount === 0 &&
        this.#held.length === 0 &&
        this.#nextIndex >= this.#sentences.length
      ) {
        this.#playing = false;
        this.#setState("ended");
      } else {
        if (this.#scheduledCount === 0 && this.#playing) {
          this.#setState("buffering");
        }
        void this.#fillQueue(generation);
      }
    });
    this.#scheduled.push({
      ...scheduled,
      sentenceIndex,
      timings: result.timings,
    });
    const paragraphGap =
      this.#sentences[sentenceIndex + 1]?.paragraphIndex !==
      sentence.paragraphIndex
        ? 0.12
        : 0;
    this.#nextAudioTime = scheduled.endAt + paragraphGap;
    this.#callbacks.onSentenceStart({
      sentenceId: sentence.id,
      sentenceIndex,
      timings: result.timings,
      timingSource: result.timingSource,
      durationMs: (result.audio.length / result.sampleRate) * 1_000,
      rate: 1,
      startedAtPerf: scheduled.startedAtPerf,
      generation,
    });
  }

  #needsMoreAudio(): boolean {
    const count = this.#scheduledCount + this.#held.length;
    if (count < MIN_BUFFERED_SENTENCES) return true;
    if (count >= this.#maxBufferedSentences) return false;
    const heldSeconds = this.#held.reduce(
      (total, { result }) => total + result.audio.length / result.sampleRate,
      0,
    );
    const scheduledSeconds = Math.max(
      0,
      this.#nextAudioTime - this.#audio.currentTime,
    );
    return scheduledSeconds + heldSeconds < this.#bufferSeconds;
  }

  async #synthesize(
    request: SynthesisRequest,
    signal: AbortSignal,
  ): Promise<SynthesisResult> {
    const key = [
      request.voiceId,
      request.speed,
      request.lang,
      request.wordIndices.join(","),
      request.text,
    ].join("\u0000");
    const cached = this.#results.get(key);
    if (cached) {
      this.#results.delete(key);
      this.#results.set(key, cached);
      return cached;
    }
    const previous = this.#synthesisChain;
    const task = previous
      .catch(() => {})
      .then(() => {
        if (signal.aborted) {
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        const startedAt = performance.now();
        return this.#engine.synthesize(request, signal).then((result) => {
          this.#recordSpeed(request, result, performance.now() - startedAt);
          return result;
        });
      });
    this.#synthesisChain = task.catch(() => {});
    const result = await task;
    this.#results.set(key, result);
    while (this.#results.size > RESULT_CACHE_SIZE) {
      const oldest = this.#results.keys().next().value;
      if (oldest === undefined) break;
      this.#results.delete(oldest);
    }
    return result;
  }

  #recordSpeed(
    request: SynthesisRequest,
    result: SynthesisResult,
    elapsedMs: number,
  ): void {
    const audioSeconds = result.audio.length / result.sampleRate;
    if (audioSeconds <= 0 || request.words.length === 0) return;
    const perWord = (audioSeconds * request.speed) / request.words.length;
    this.#secondsPerWord =
      this.#secondsPerWord === null
        ? perWord
        : this.#secondsPerWord * 0.7 + perWord * 0.3;
    this.#measuredSyntheses += 1;
    // The first synthesis can include loading the model.
    if (this.#measuredSyntheses === 1) return;
    const factor = elapsedMs / 1_000 / audioSeconds;
    this.#realtimeFactor =
      this.#realtimeFactor === null
        ? factor
        : this.#realtimeFactor * 0.6 + factor * 0.4;
  }

  #requestFor(
    sentence: PlayableSentence,
    words: PlayableWord[],
  ): SynthesisRequest {
    const spoken = words.map((word) => word.spoken.join(" "));
    return {
      sentenceId: sentence.id,
      lang: sentence.lang,
      voiceId: this.#voiceId,
      wordIndices: words.map((word) => word.index),
      words: spoken,
      text: spoken.join(" "),
      speed: this.#speed,
    };
  }

  #sentenceIndexForWord(wordIndex: number): number {
    const found = this.#sentences.findIndex((sentence) => {
      const first = sentence.words[0]?.index;
      const last = sentence.words.at(-1)?.index;
      return (
        first !== undefined &&
        last !== undefined &&
        first <= wordIndex &&
        last >= wordIndex
      );
    });
    return found < 0 ? this.#sentences.length : found;
  }

  #currentSchedule(): ScheduledSentence | undefined {
    const now = this.#audio.currentTime;
    return (
      this.#scheduled.find(
        (schedule) => schedule.startAt <= now && schedule.endAt >= now,
      ) ?? this.#scheduled.find((schedule) => schedule.startAt > now)
    );
  }

  #currentSentenceIndex(): number {
    return (
      this.#currentSchedule()?.sentenceIndex ??
      this.#held[0]?.sentenceIndex ??
      this.#nextIndex
    );
  }

  #resetPlayback(): void {
    this.#generation += 1;
    this.#playing = false;
    this.#controller?.abort();
    this.#controller = null;
    this.#audio.stop();
    this.#scheduled = [];
    this.#held = [];
    this.#scheduledCount = 0;
    this.#fillTask = null;
  }

  #setState(state: SessionState, error?: string): void {
    this.#state = state;
    this.#callbacks.onState(state, error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Speech playback failed.";
}
