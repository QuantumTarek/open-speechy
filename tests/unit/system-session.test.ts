import { describe, expect, it } from "vitest";
import type {
  SynthesisRequest,
  StreamingSpeechEngine,
  StreamingSpeechHandlers,
} from "../../src/engines/types";
import {
  SystemSpeechSession,
  type SystemSessionCallbacks,
} from "../../src/playback/system-session";
import type { PlayableSentence } from "../../src/playback/session";

class FakeStreamingEngine implements StreamingSpeechEngine {
  readonly id = "system" as const;
  readonly requests: Array<{
    request: SynthesisRequest;
    handlers: StreamingSpeechHandlers;
  }> = [];
  stops = 0;
  pauses = 0;
  resumes = 0;

  speak(
    request: SynthesisRequest,
    handlers: StreamingSpeechHandlers,
  ): void {
    this.requests.push({ request, handlers });
  }

  pause(): void {
    this.pauses += 1;
  }

  resume(): void {
    this.resumes += 1;
  }

  stop(): void {
    this.stops += 1;
  }

  start(index: number): void {
    this.requests[index].handlers.onStart();
  }

  word(requestIndex: number, wordIndex: number): void {
    this.requests[requestIndex].handlers.onWord(wordIndex, {
      type: "word",
      charIndex: 0,
    });
  }

  end(index: number): void {
    this.requests[index].handlers.onEnd();
  }
}

function sentences(): PlayableSentence[] {
  return [
    {
      id: "s0",
      index: 0,
      paragraphIndex: 0,
      lang: "en",
      text: "One two.",
      words: [
        { index: 0, display: "One", spoken: ["one"] },
        { index: 1, display: "two.", spoken: ["two"] },
      ],
    },
    {
      id: "s1",
      index: 1,
      paragraphIndex: 0,
      lang: "en",
      text: "Three four.",
      words: [
        { index: 2, display: "Three", spoken: ["three"] },
        { index: 3, display: "four.", spoken: ["four"] },
      ],
    },
  ];
}

function makeSession(engine: FakeStreamingEngine) {
  const states: string[] = [];
  const words: number[] = [];
  const callbacks: SystemSessionCallbacks = {
    onState: (state) => states.push(state),
    onWord: (_sentenceId, wordIndex) => words.push(wordIndex),
  };
  return {
    session: new SystemSpeechSession(engine, callbacks),
    states,
    words,
  };
}

describe("system speech session", () => {
  it("starts at a requested word and advances when Chrome ends a sentence", () => {
    const engine = new FakeStreamingEngine();
    const { session, states, words } = makeSession(engine);

    session.start(sentences(), { startWordIndex: 1, speed: 1.5 });
    expect(engine.requests[0].request.text).toBe("two");
    expect(engine.requests[0].request.speed).toBe(1.5);
    engine.start(0);
    engine.end(0);

    expect(engine.requests[1].request.text).toBe("three four");
    expect(states).toContain("playing");
    expect(session.state).toBe("playing");
    expect(words).toEqual([1]);
  });

  it("pauses, seeks without speaking, then resumes from the selected word", () => {
    const engine = new FakeStreamingEngine();
    const { session, words } = makeSession(engine);

    session.start(sentences());
    engine.start(0);
    session.pause();
    session.seek(3);

    expect(session.state).toBe("paused");
    expect(engine.requests).toHaveLength(1);
    expect(words.at(-1)).toBe(3);

    session.resume();
    expect(engine.requests[1].request.text).toBe("four");
    expect(engine.resumes).toBe(0);
  });

  it("restarts from the current word when speed changes", () => {
    const engine = new FakeStreamingEngine();
    const { session } = makeSession(engine);

    session.start(sentences());
    engine.start(0);
    engine.word(0, 1);
    session.setSpeed(2);

    expect(engine.requests).toHaveLength(2);
    expect(engine.requests[1].request.wordIndices).toEqual([1]);
    expect(engine.requests[1].request.speed).toBe(2);
  });
});
