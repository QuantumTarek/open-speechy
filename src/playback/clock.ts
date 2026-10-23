import type { WordTiming } from "../engines/types";
import { timingForWord } from "../engines/timings";
import type { Highlighter } from "../highlight/highlighter";

export interface ClockSegment {
  sentenceId: string;
  timings: WordTiming[];
  durationMs: number;
  rate: number;
  startedAtPerf: number;
  generation?: number;
}

export interface ClockTick {
  wordIndex: number;
  driftMs: number;
}

export class PlaybackClock {
  readonly #highlighter: Highlighter;
  readonly #onTick: (tick: ClockTick) => void;
  readonly #segments: ClockSegment[] = [];
  #frameId = 0;
  #pausedAt: number | null = null;
  #lastWordIndex: number | null = null;
  #generation = 0;

  constructor(highlighter: Highlighter, onTick: (tick: ClockTick) => void) {
    this.#highlighter = highlighter;
    this.#onTick = onTick;
  }

  addSegment(segment: ClockSegment): void {
    // After a seek the session reschedules from a new generation. Audio queued
    // before it was stopped, so its segments must not highlight later words.
    const generation = segment.generation ?? this.#generation;
    if (generation < this.#generation) return;
    if (generation > this.#generation) {
      this.#generation = generation;
      this.#segments.length = 0;
    }
    this.#segments.push(segment);
    this.#segments.sort(
      (left, right) => left.startedAtPerf - right.startedAtPerf,
    );
    if (!this.#frameId && this.#pausedAt === null) this.#scheduleFrame();
  }

  setPaused(paused: boolean): void {
    if (paused && this.#pausedAt === null) {
      this.#pausedAt = performance.now();
      cancelAnimationFrame(this.#frameId);
      this.#frameId = 0;
      return;
    }
    if (!paused && this.#pausedAt !== null) {
      const pauseDuration = performance.now() - this.#pausedAt;
      for (const segment of this.#segments) {
        segment.startedAtPerf += pauseDuration;
      }
      this.#pausedAt = null;
      this.#scheduleFrame();
    }
  }

  resync(positionMs: number, rate: number): void {
    const current = this.#activeSegment(performance.now());
    if (!current) return;
    current.startedAtPerf = performance.now() - positionMs / rate;
    current.rate = rate;
  }

  stop(): void {
    cancelAnimationFrame(this.#frameId);
    this.#frameId = 0;
    this.#segments.length = 0;
    this.#lastWordIndex = null;
    this.#pausedAt = null;
    this.#highlighter.highlightWord(null);
  }

  #scheduleFrame(): void {
    this.#frameId = requestAnimationFrame(() => this.#tick());
  }

  #tick(): void {
    this.#frameId = 0;
    if (this.#pausedAt !== null) return;
    const now = performance.now();
    const active = this.#activeSegment(now);
    if (!active) {
      if (this.#segments.some((segment) => segment.startedAtPerf > now)) {
        this.#scheduleFrame();
      }
      return;
    }

    const positionMs = Math.max(0, (now - active.startedAtPerf) * active.rate);
    const timing = timingForWord(active.timings, positionMs);
    if (timing) {
      this.#highlighter.highlightWord(timing.wordIndex, active.sentenceId);
      if (timing.wordIndex !== this.#lastWordIndex) {
        this.#lastWordIndex = timing.wordIndex;
        this.#onTick({
          wordIndex: timing.wordIndex,
          driftMs: Math.round(positionMs - timing.startMs),
        });
      }
    }
    this.#scheduleFrame();
  }

  #activeSegment(now: number): ClockSegment | undefined {
    for (let index = this.#segments.length - 1; index >= 0; index -= 1) {
      const segment = this.#segments[index];
      if (segment.startedAtPerf <= now) {
        const elapsed = (now - segment.startedAtPerf) * segment.rate;
        if (elapsed <= segment.durationMs) return segment;
      }
    }
    return undefined;
  }
}
