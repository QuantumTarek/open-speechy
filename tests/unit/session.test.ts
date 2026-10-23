import { describe, expect, it, vi } from "vitest";
import type {
  SynthesisRequest,
  SynthesisResult,
} from "../../src/engines/types";
import { FakeEngine } from "../../src/engines/fake";
import type {
  AudioScheduler,
  ScheduledAudio,
} from "../../src/playback/audio-player";
import {
  SessionQueue,
  type PlayableSentence,
  type SessionState,
} from "../../src/playback/session";

class RecordingAudio implements AudioScheduler {
  currentTime = 0;
  paused = false;
  readonly sources: Array<{
    result: SynthesisResult;
    startAt: number;
    onEnded: () => void;
  }> = [];

  async resume(): Promise<void> {
    this.paused = false;
  }

  async suspend(): Promise<void> {
    this.paused = true;
  }

  schedule(
    result: SynthesisResult,
    startAt: number,
    onEnded: () => void,
  ): ScheduledAudio {
    this.sources.push({ result, startAt, onEnded });
    const duration = result.audio.length / result.sampleRate;
    return {
      startAt,
      endAt: startAt + duration,
      startedAtPerf: 1_000 + startAt * 1_000,
    };
  }

  stop(): void {
    this.sources.length = 0;
  }

  async close(): Promise<void> {
    this.stop();
  }
}

// Each synthesis waits until the test releases it.
class GatedEngine extends FakeEngine {
  calls = 0;
  maxConcurrent = 0;
  #running = 0;
  #gates: Array<() => void> = [];

  override async synthesize(
    request: SynthesisRequest,
    signal: AbortSignal,
  ): Promise<SynthesisResult> {
    this.calls += 1;
    this.#running += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#running);
    try {
      await new Promise<void>((resolve) => this.#gates.push(resolve));
      return await super.synthesize(request, signal);
    } finally {
      this.#running -= 1;
    }
  }

  async release(): Promise<void> {
    await flush();
    this.#gates.shift()?.();
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function sentences(): PlayableSentence[] {
  return [
    {
      id: "s0",
      index: 0,
      paragraphIndex: 0,
      lang: "en",
      text: "First sentence.",
      words: [
        { index: 0, display: "First", spoken: ["First"] },
        { index: 1, display: "sentence.", spoken: ["sentence"] },
      ],
    },
    {
      id: "s1",
      index: 1,
      paragraphIndex: 0,
      lang: "en",
      text: "Second sentence.",
      words: [
        { index: 2, display: "Second", spoken: ["Second"] },
        { index: 3, display: "sentence.", spoken: ["sentence"] },
      ],
    },
    {
      id: "s2",
      index: 2,
      paragraphIndex: 1,
      lang: "en",
      text: "Third paragraph.",
      words: [{ index: 4, display: "Third", spoken: ["Third"] }],
    },
  ];
}

describe("session queue", () => {
  it("queues sentences by buffered audio time and starts them without a gap", async () => {
    const audio = new RecordingAudio();
    const starts: string[] = [];
    const states: SessionState[] = [];
    const queue = new SessionQueue(new FakeEngine(), audio, {
      onState: (state) => states.push(state),
      onSentenceStart: ({ sentenceId }) => starts.push(sentenceId),
    });

    await queue.start(sentences());

    expect(queue.state).toBe("playing");
    expect(audio.sources).toHaveLength(3);
    expect(audio.sources[1].startAt).toBe(audio.sources[0].startAt + 0.24);
    expect(audio.sources[2].startAt).toBeCloseTo(
      audio.sources[1].startAt + 0.24 + 0.12,
    );
    expect(starts).toEqual(["s0", "s1", "s2"]);
    expect(states.slice(0, 2)).toEqual(["loading", "playing"]);
  });

  it("stops synthesizing at the buffer target and refills as audio plays", async () => {
    const audio = new RecordingAudio();
    const queue = new SessionQueue(
      new FakeEngine(),
      audio,
      { onState: () => {}, onSentenceStart: () => {} },
      { bufferSeconds: 0.3 },
    );

    await queue.start(sentences());
    expect(audio.sources).toHaveLength(2);

    audio.currentTime = audio.sources[0].startAt + 0.24;
    audio.sources[0].onEnded();
    await flush();
    expect(audio.sources).toHaveLength(3);
  });

  it("holds a short first sentence until the next is ready, then reports buffering if playback outruns synthesis", async () => {
    const audio = new RecordingAudio();
    const engine = new GatedEngine();
    const states: SessionState[] = [];
    const queue = new SessionQueue(engine, audio, {
      onState: (state) => states.push(state),
      onSentenceStart: () => {},
    });

    const started = queue.start(sentences());
    await engine.release();
    await flush();
    // 0.24 s of audio would run out before the next sentence is ready.
    expect(queue.state).toBe("loading");
    expect(audio.sources).toHaveLength(0);
    await engine.release();
    await flush();
    expect(queue.state).toBe("playing");
    expect(audio.sources).toHaveLength(2);
    expect(audio.sources[1].startAt).toBe(audio.sources[0].startAt + 0.24);

    audio.sources[0].onEnded();
    audio.sources[1].onEnded();
    expect(queue.state).toBe("buffering");
    await engine.release();
    await started;
    expect(queue.state).toBe("playing");
    expect(states).toEqual(["loading", "playing", "buffering", "playing"]);
  });

  it("reuses buffered sentences after a seek and starts a new generation", async () => {
    const audio = new RecordingAudio();
    const engine = new FakeEngine();
    const synthesize = vi.spyOn(engine, "synthesize");
    const generations: number[] = [];
    const queue = new SessionQueue(engine, audio, {
      onState: () => {},
      onSentenceStart: ({ generation }) => generations.push(generation),
    });

    await queue.start(sentences());
    expect(synthesize).toHaveBeenCalledTimes(3);
    await queue.seek(2);

    expect(synthesize).toHaveBeenCalledTimes(3);
    expect(audio.sources).toHaveLength(2);
    expect(new Set(generations).size).toBe(2);
    expect(generations.at(-1)).toBeGreaterThan(generations[0]);
  });

  it("runs one synthesis at a time when a seek interrupts one", async () => {
    const audio = new RecordingAudio();
    const engine = new GatedEngine();
    const queue = new SessionQueue(engine, audio, {
      onState: () => {},
      onSentenceStart: () => {},
    });

    void queue.start(sentences());
    await flush();
    const seeking = queue.seek(4);
    await flush();
    expect(engine.calls).toBe(1);

    await engine.release();
    await flush();
    expect(engine.calls).toBe(2);
    expect(engine.maxConcurrent).toBe(1);
    await engine.release();
    await seeking;
  });

  it("pauses and resumes the audio context", async () => {
    const audio = new RecordingAudio();
    const queue = new SessionQueue(new FakeEngine(), audio, {
      onState: () => {},
      onSentenceStart: () => {},
    });

    await queue.start(sentences());
    await queue.pause();
    expect(queue.state).toBe("paused");
    expect(audio.paused).toBe(true);

    await queue.resume();
    expect(queue.state).toBe("playing");
    expect(audio.paused).toBe(false);
    await queue.stop();
    expect(queue.state).toBe("idle");
  });
});
