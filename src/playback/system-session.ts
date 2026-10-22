import type { SynthesisRequest, StreamingSpeechEngine } from "../engines/types";
import type {
  PlayableSentence,
  PlayableWord,
  SessionState,
} from "./session";

export interface SystemSessionCallbacks {
  onState(state: SessionState, error?: string): void;
  onWord(sentenceId: string, wordIndex: number): void;
}

export class SystemSpeechSession {
  readonly #engine: StreamingSpeechEngine;
  readonly #callbacks: SystemSessionCallbacks;
  #sentences: PlayableSentence[] = [];
  #sentenceIndex = 0;
  #currentWordIndex: number | null = null;
  #generation = 0;
  #speed = 1;
  #state: SessionState = "idle";
  #startedAt = 0;
  #pendingSentence = false;

  constructor(
    engine: StreamingSpeechEngine,
    callbacks: SystemSessionCallbacks,
  ) {
    this.#engine = engine;
    this.#callbacks = callbacks;
  }

  get state(): SessionState {
    return this.#state;
  }

  get currentWordIndex(): number | null {
    return this.#currentWordIndex;
  }

  start(
    sentences: PlayableSentence[],
    options: { startWordIndex?: number; speed?: number } = {},
  ): void {
    this.#invalidate();
    this.#sentences = sentences;
    this.#speed = clampSpeed(options.speed ?? this.#speed);
    this.#sentenceIndex = this.#sentenceIndexForWord(
      options.startWordIndex ?? sentences[0]?.words[0]?.index ?? 0,
    );
    this.#currentWordIndex =
      options.startWordIndex ??
      sentences[this.#sentenceIndex]?.words[0]?.index ??
      null;

    if (this.#sentenceIndex >= sentences.length) {
      this.#setState("error", "No readable sentences were found.");
      return;
    }

    this.#setState("loading");
    this.#speakCurrent(this.#generation);
  }

  pause(): void {
    if (this.#state !== "playing") return;
    this.#engine.pause();
    this.#setState("paused");
  }

  resume(): void {
    if (this.#state !== "paused") return;
    if (this.#pendingSentence) {
      this.#pendingSentence = false;
      this.#speakCurrent(this.#generation);
      return;
    }
    this.#engine.resume();
    this.#setState("playing");
  }

  toggle(): void {
    if (this.#state === "paused") this.resume();
    else if (this.#state === "playing") this.pause();
    else if (this.#state === "idle" || this.#state === "ended") {
      this.start(this.#sentences);
    }
  }

  next(): void {
    const next = this.#sentences[this.#sentenceIndex + 1];
    if (next?.words[0]) this.seek(next.words[0].index);
  }

  previous(): void {
    const targetIndex =
      Date.now() - this.#startedAt < 1_500
        ? Math.max(0, this.#sentenceIndex - 1)
        : this.#sentenceIndex;
    const target = this.#sentences[targetIndex]?.words[0];
    if (target) this.seek(target.index);
  }

  seek(wordIndex: number): void {
    const sentenceIndex = this.#sentenceIndexForWord(wordIndex);
    if (sentenceIndex >= this.#sentences.length) return;
    const wasPaused = this.#state === "paused";
    this.#invalidate();
    this.#sentenceIndex = sentenceIndex;
    this.#currentWordIndex = wordIndex;
    const sentence = this.#sentences[sentenceIndex];
    this.#callbacks.onWord(sentence.id, wordIndex);

    if (wasPaused) {
      this.#pendingSentence = true;
      this.#setState("paused");
    } else {
      this.#setState("loading");
      this.#speakCurrent(this.#generation);
    }
  }

  setSpeed(speed: number): void {
    const nextSpeed = clampSpeed(speed);
    if (nextSpeed === this.#speed) return;
    this.#speed = nextSpeed;
    if (this.#currentWordIndex !== null) this.seek(this.#currentWordIndex);
  }

  stop(): void {
    this.#invalidate();
    this.#sentences = [];
    this.#currentWordIndex = null;
    this.#setState("idle");
  }

  #speakCurrent(generation: number): void {
    const sentence = this.#sentences[this.#sentenceIndex];
    if (!sentence) {
      this.#setState("ended");
      return;
    }
    const words = sentence.words.filter(
      (word) =>
        this.#currentWordIndex === null ||
        word.index >= this.#currentWordIndex,
    );
    this.#currentWordIndex = null;
    if (words.length === 0) {
      this.#sentenceIndex += 1;
      this.#speakCurrent(generation);
      return;
    }

    const request = this.#requestFor(sentence, words);
    try {
      this.#engine.speak(request, {
        onStart: () => {
          if (generation !== this.#generation) return;
          this.#startedAt = Date.now();
          this.#setState("playing");
          const firstWord = words[0];
          if (firstWord) this.#notifyWord(sentence.id, firstWord.index);
        },
        onWord: (wordIndex) => {
          if (generation === this.#generation) {
            this.#notifyWord(sentence.id, wordIndex);
          }
        },
        onEnd: () => {
          if (generation !== this.#generation) return;
          this.#sentenceIndex += 1;
          const next = this.#sentences[this.#sentenceIndex];
          if (next) this.#speakCurrent(generation);
          else this.#setState("ended");
        },
        onError: (error) => {
          if (generation === this.#generation) {
            this.#setState("error", error.message);
          }
        },
      });
    } catch (error) {
      this.#setState(
        "error",
        error instanceof Error ? error.message : "System speech failed.",
      );
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
      voiceId: "system",
      wordIndices: words.map((word) => word.index),
      words: spoken,
      text: spoken.join(" "),
      speed: this.#speed,
    };
  }

  #sentenceIndexForWord(wordIndex: number): number {
    const index = this.#sentences.findIndex((sentence) => {
      const first = sentence.words[0]?.index;
      const last = sentence.words.at(-1)?.index;
      return (
        first !== undefined &&
        last !== undefined &&
        first <= wordIndex &&
        last >= wordIndex
      );
    });
    return index < 0 ? this.#sentences.length : index;
  }

  #notifyWord(sentenceId: string, wordIndex: number): void {
    this.#currentWordIndex = wordIndex;
    this.#callbacks.onWord(sentenceId, wordIndex);
  }

  #invalidate(): void {
    this.#generation += 1;
    this.#pendingSentence = false;
    this.#engine.stop();
  }

  #setState(state: SessionState, error?: string): void {
    this.#state = state;
    this.#callbacks.onState(state, error);
  }
}

function clampSpeed(speed: number): number {
  return Math.min(3, Math.max(0.5, speed));
}
