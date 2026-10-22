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

export type SessionState =
  "idle" | "loading" | "playing" | "paused" | "ended" | "error";

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
  }): void;
}

interface ScheduledSentence extends ScheduledAudio {
  sentenceIndex: number;
  timings: WordTiming[];
}

const DEFAULT_LOOKAHEAD = 2;

export class SessionQueue {
  readonly #engine: TtsEngine;
  readonly #audio: AudioScheduler;
  readonly #callbacks: SessionCallbacks;
  readonly #lookahead: number;
  #sentences: PlayableSentence[] = [];
  #scheduled: ScheduledSentence[] = [];
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
    options: { lookahead?: number } = {},
  ) {
    this.#engine = engine;
    this.#audio = audio;
    this.#callbacks = callbacks;
    this.#lookahead = Math.min(
      4,
      Math.max(1, options.lookahead ?? DEFAULT_LOOKAHEAD),
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
    try {
      await this.#engine.init();
      await this.#audio.resume();
      this.#playing = true;
      this.#setState("playing");
      await this.#fillQueue(this.#generation);
    } catch (error) {
      this.#playing = false;
      this.#setState("error", errorMessage(error));
    }
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
    this.#setState("playing");
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
      this.#setState("playing");
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
    while (
      this.#playing &&
      generation === this.#generation &&
      this.#scheduledCount < this.#lookahead &&
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
        result = await this.#engine.synthesize(
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
          this.#nextIndex >= this.#sentences.length
        ) {
          this.#playing = false;
          this.#setState("ended");
        } else {
          void this.#fillQueue(generation);
        }
      });
      this.#scheduled.push({
        ...scheduled,
        sentenceIndex,
        timings: result.timings,
      });
      this.#nextIndex += 1;
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
      });
    }
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
    return this.#currentSchedule()?.sentenceIndex ?? this.#nextIndex;
  }

  #resetPlayback(): void {
    this.#generation += 1;
    this.#playing = false;
    this.#controller?.abort();
    this.#controller = null;
    this.#audio.stop();
    this.#scheduled = [];
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
