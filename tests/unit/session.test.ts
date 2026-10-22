import { describe, expect, it } from "vitest";
import type { SynthesisResult } from "../../src/engines/types";
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
  it("keeps two sentences scheduled and starts them without a sentence gap", async () => {
    const audio = new RecordingAudio();
    const starts: string[] = [];
    const states: SessionState[] = [];
    const queue = new SessionQueue(new FakeEngine(), audio, {
      onState: (state) => states.push(state),
      onSentenceStart: ({ sentenceId }) => starts.push(sentenceId),
    });

    await queue.start(sentences());

    expect(queue.state).toBe("playing");
    expect(audio.sources).toHaveLength(2);
    expect(audio.sources[1].startAt).toBe(audio.sources[0].startAt + 0.24);
    expect(starts).toEqual(["s0", "s1"]);
    expect(states).toContain("loading");
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
