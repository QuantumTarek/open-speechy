export type Lang = 'en' | 'ar';

export interface VoiceInfo {
  id: string;
  engineId: EngineId;
  lang: Lang;
  name: string;
  quality: 'premium' | 'enhanced' | 'standard' | 'compact';
  local: boolean;
  supportsWordTimings: boolean;
  sizeBytes?: number;
  installed: boolean;
}

export type EngineId = 'system' | 'kokoro' | 'piper' | 'server';

export interface WordTiming {
  wordIndex: number;
  startMs: number;
  endMs: number;
}

export interface SynthesisResult {
  audio: Float32Array;
  sampleRate: number;
  timings: WordTiming[];
  timingSource: 'model' | 'estimated' | 'aligned';
}

export interface SynthesisRequest {
  sentenceId: string;
  lang: Lang;
  voiceId: string;
  wordIndices: number[];
  words: string[];
  text: string;
  speed: number;
}

export interface TtsEngine {
  id: EngineId;
  init(
    onProgress?: (progress: {
      loaded: number;
      total: number;
      stage: string;
    }) => void,
  ): Promise<void>;
  isReady(): boolean;
  listVoices(): Promise<VoiceInfo[]>;
  synthesize(
    req: SynthesisRequest,
    signal: AbortSignal,
  ): Promise<SynthesisResult>;
  dispose(): Promise<void>;
}

export interface StreamingSpeechHandlers {
  onEvent(event: chrome.tts.TtsEvent): void;
  onError(error: Error): void;
}

export interface StreamingSpeechEngine {
  id: 'system';
  speak(req: SynthesisRequest, handlers: StreamingSpeechHandlers): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export interface SpeechWord {
  index: number;
  display: string;
  spoken: string[];
  pieces: TextPiece[];
}

export interface TextPiece {
  node: Text;
  start: number;
  end: number;
  offset: number;
}

export interface SentencePlan {
  id: string;
  index: number;
  paragraphIndex: number;
  lang: Lang;
  text: string;
  spokenText: string;
  words: SpeechWord[];
}
