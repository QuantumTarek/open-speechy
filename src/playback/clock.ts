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

// Upper bound between checks, so a resync or a missed boundary is corrected
// quickly without waking up on every frame.
const MAX_TICK_DELAY_MS = 250;

export interface ClockTick {
  wordIndex: number;
  driftMs: number;
}

export class PlaybackClock {
  readonly #highlighter: Highlighter;
  readonly #onTick: (tick: ClockTick) => void;
  readonly #segments: ClockSegment[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
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
    if (this.#pausedAt === null) this.#scheduleTick(0);
  }

  setPaused(paused: boolean): void {
    if (paused && this.#pausedAt === null) {
      this.#pausedAt = performance.now();
      this.#cancelTick();
      return;
    }
    if (!paused && this.#pausedAt !== null) {
      const pauseDuration = performance.now() - this.#pausedAt;
      for (const segment of this.#segments) {
        segment.startedAtPerf += pauseDuration;
      }
      this.#pausedAt = null;
      this.#scheduleTick(0);
    }
  }

  resync(positionMs: number, rate: number): void {
    const current = this.#activeSegment(performance.now());
    if (!current) return;
    current.startedAtPerf = performance.now() - positionMs / rate;
    current.rate = rate;
    if (this.#pausedAt === null) this.#scheduleTick(0);
  }

  stop(): void {
    this.#cancelTick();
    this.#segments.length = 0;
    this.#lastWordIndex = null;
    this.#pausedAt = null;
    this.#highlighter.highlightWord(null);
  }

  // Wakes up at the next word boundary instead of on every animation frame,
  // so the page is not kept busy between words or while audio is buffering.
  #scheduleTick(delayMs: number): void {
    this.#cancelTick();
    this.#timer = setTimeout(() => this.#tick(), Math.max(0, delayMs));
  }

  #cancelTick(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #tick(): void {
    this.#timer = null;
    if (this.#pausedAt !== null) return;
    const now = performance.now();
    const nextStart = this.#nextSegmentStart(now);
    const active = this.#activeSegment(now);
    if (!active) {
      if (nextStart !== undefined) this.#scheduleTick(nextStart - now + 1);
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

    let boundaryMs = active.durationMs;
    if (timing && timing.startMs > positionMs) boundaryMs = timing.startMs;
    else if (timing && timing.endMs > positionMs) boundaryMs = timing.endMs;
    let delayMs = Math.max(0, boundaryMs - positionMs) / active.rate + 1;
    if (nextStart !== undefined) delayMs = Math.min(delayMs, nextStart - now + 1);
    this.#scheduleTick(Math.min(MAX_TICK_DELAY_MS, delayMs));
  }

  #nextSegmentStart(now: number): number | undefined {
    return this.#segments.find((segment) => segment.startedAtPerf > now)
      ?.startedAtPerf;
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
