import type { SynthesisResult } from "../engines/types";

export interface ScheduledAudio {
  startAt: number;
  endAt: number;
  startedAtPerf: number;
}

export interface AudioScheduler {
  readonly currentTime: number;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  schedule(
    result: SynthesisResult,
    startAt: number,
    onEnded: () => void,
  ): ScheduledAudio;
  stop(): void;
  close(): Promise<void>;
}

export class WebAudioPlayer implements AudioScheduler {
  readonly #context: AudioContext;
  readonly #sources = new Set<AudioBufferSourceNode>();

  constructor(context?: AudioContext) {
    this.#context =
      context ??
      new AudioContext({
        latencyHint: "interactive",
      });
  }

  get currentTime(): number {
    return this.#context.currentTime;
  }

  async resume(): Promise<void> {
    if (this.#context.state !== "running") await this.#context.resume();
  }

  async suspend(): Promise<void> {
    if (this.#context.state === "running") await this.#context.suspend();
  }

  schedule(
    result: SynthesisResult,
    startAt: number,
    onEnded: () => void,
  ): ScheduledAudio {
    const buffer = this.#context.createBuffer(
      1,
      result.audio.length,
      result.sampleRate,
    );
    buffer.getChannelData(0).set(result.audio);
    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#context.destination);
    this.#sources.add(source);
    source.onended = () => {
      this.#sources.delete(source);
      source.disconnect();
      onEnded();
    };
    source.start(startAt);

    const start = Math.max(startAt, this.#context.currentTime);
    const duration = buffer.duration;
    return {
      startAt: start,
      endAt: start + duration,
      startedAtPerf:
        performance.now() +
        Math.max(0, startAt - this.#context.currentTime) * 1_000,
    };
  }

  stop(): void {
    for (const source of this.#sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source may have ended between scheduling and stopping.
      }
      source.disconnect();
    }
    this.#sources.clear();
  }

  async close(): Promise<void> {
    this.stop();
    if (this.#context.state !== "closed") await this.#context.close();
  }
}

export class FakeAudioPlayer implements AudioScheduler {
  #position = 0;
  #anchor = performance.now();
  #running = false;
  readonly #jobs = new Set<{
    timer: ReturnType<typeof setTimeout> | null;
    endAt: number;
    onEnded: () => void;
  }>();

  get currentTime(): number {
    return (
      this.#position +
      (this.#running ? (performance.now() - this.#anchor) / 1_000 : 0)
    );
  }

  async resume(): Promise<void> {
    if (this.#running) return;
    this.#anchor = performance.now();
    this.#running = true;
  }

  async suspend(): Promise<void> {
    if (!this.#running) return;
    this.#position = this.currentTime;
    this.#running = false;
  }

  schedule(
    result: SynthesisResult,
    startAt: number,
    onEnded: () => void,
  ): ScheduledAudio {
    const now = this.currentTime;
    const scheduledStart = Math.max(now, startAt);
    const endAt = scheduledStart + result.audio.length / result.sampleRate;
    const job: {
      timer: ReturnType<typeof setTimeout> | null;
      endAt: number;
      onEnded: () => void;
    } = { timer: null, endAt, onEnded };
    this.#jobs.add(job);

    const check = () => {
      job.timer = null;
      if (this.currentTime < job.endAt) {
        job.timer = setTimeout(check, 25);
        return;
      }
      this.#jobs.delete(job);
      job.onEnded();
    };
    job.timer = setTimeout(
      check,
      Math.max(0, (endAt - this.currentTime) * 1_000),
    );

    return {
      startAt: scheduledStart,
      endAt,
      startedAtPerf:
        performance.now() + Math.max(0, startAt - now) * 1_000,
    };
  }

  stop(): void {
    for (const job of this.#jobs) {
      if (job.timer !== null) clearTimeout(job.timer);
    }
    this.#jobs.clear();
  }

  async close(): Promise<void> {
    this.stop();
    this.#running = false;
  }
}
