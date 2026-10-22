import type { KeyboardEvent } from "react";
import type { Lang, VoiceInfo } from "../engines/types";
import type { SessionControlAction } from "../messaging/protocol";
import type { SessionState } from "../playback/session";

export interface PlayerBarProps {
  status: SessionState;
  error?: string;
  notice?: string;
  totalWords: number;
  currentWordIndex: number | null;
  driftMs: number;
  speed: number;
  title: string;
  voices: VoiceInfo[];
  voiceId: string;
  lang: Lang;
  onControl(action: SessionControlAction): void;
  onSpeed(speed: number): void;
  onVoice(voiceId: string): void;
  onClose(): void;
}

export function PlayerBar(props: PlayerBarProps) {
  const playing = props.status === "playing";
  const busy = props.status === "loading";
  const wordNumber =
    props.currentWordIndex === null
      ? 0
      : Math.min(props.totalWords, props.currentWordIndex + 1);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === " ") {
      event.preventDefault();
      props.onControl("toggle");
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      props.onControl("previous");
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      props.onControl("next");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      props.onSpeed(Math.min(3, props.speed + 0.1));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      props.onSpeed(Math.max(0.5, props.speed - 0.1));
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    }
  }

  return (
    <div
      className="player"
      role="region"
      aria-label="Open Speechy player"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      dir="auto"
    >
      <div className="player__copy">
        <span className="player__eyebrow">OPEN SPEECHY</span>
        <strong className="player__title">{props.title}</strong>
        <span className="player__status" aria-live="polite">
          {props.error ??
            props.notice ??
            (busy
              ? "Preparing voice"
              : props.totalWords > 0
                ? `Word ${wordNumber} of ${props.totalWords}`
                : "Ready to read")}
        </span>
      </div>
      <div className="player__controls" aria-label="Playback controls">
        <button
          type="button"
          aria-label="Previous sentence"
          onClick={() => props.onControl("previous")}
        >
          <span aria-hidden="true">|&lt;</span>
        </button>
        <button
          className="player__play"
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          disabled={props.status === "error"}
          onClick={() => props.onControl("toggle")}
        >
          <span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>
        </button>
        <button
          type="button"
          aria-label="Next sentence"
          onClick={() => props.onControl("next")}
        >
          <span aria-hidden="true">&gt;|</span>
        </button>
      </div>
      <label className="player__speed">
        <span>{props.speed.toFixed(1)}×</span>
        <input
          type="range"
          min="0.5"
          max="3"
          step="0.1"
          value={props.speed}
          aria-label="Reading speed"
          onChange={(event) => props.onSpeed(Number(event.currentTarget.value))}
        />
      </label>
      <label className="player__voice">
        <span>Voice</span>
        <select
          aria-label="Reading voice"
          value={props.voiceId}
          onChange={(event) => props.onVoice(event.currentTarget.value)}
        >
          {props.voices
            .filter((voice) => voice.lang === props.lang)
            .map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.name} · {qualityLabel(voice)}
              </option>
            ))}
        </select>
      </label>
      <span className="player__drift" aria-live="off">
        {props.status === "playing" ? `Drift ${props.driftMs} ms` : ""}
      </span>
      <button
        className="player__close"
        type="button"
        aria-label="Close reader"
        onClick={props.onClose}
      >
        ×
      </button>
    </div>
  );
}

function qualityLabel(voice: VoiceInfo): string {
  if (voice.engineId === "system") {
    return voice.quality === "standard" || voice.quality === "compact"
      ? `${voice.quality}${voice.supportsWordTimings ? "" : ", no word events"}`
      : voice.quality;
  }
  return voice.engineId === "server" ? "Local server" : "On-device";
}
