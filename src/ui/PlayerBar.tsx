import { useState, type KeyboardEvent, type ReactNode } from "react";
import type { Lang, VoiceInfo } from "../engines/types";
import type { SessionControlAction } from "../messaging/protocol";
import type { SessionState } from "../playback/session";
import { t } from "../i18n";

export interface PlayerBarProps {
  status: SessionState;
  error?: string;
  notice?: string;
  // First-use model download, from 0 to 1. Null when nothing is downloading.
  downloadProgress?: number | null;
  totalWords: number;
  currentWordIndex: number | null;
  driftMs: number;
  speed: number;
  title: string;
  voices: VoiceInfo[];
  voiceId: string;
  lang: Lang;
  showJumpToCurrent?: boolean;
  onControl(action: SessionControlAction): void;
  onSpeed(speed: number): void;
  onVoice(voiceId: string): void;
  onJumpToCurrent(): void;
  onClose(): void;
}

const SPEED_PRESETS = [0.8, 1, 1.25, 1.5, 2];

export function PlayerBar(props: PlayerBarProps) {
  const [expanded, setExpanded] = useState(false);
  const downloading =
    props.downloadProgress !== undefined && props.downloadProgress !== null;
  const buffering = props.status === "buffering";
  const playing = props.status === "playing" || buffering;
  const busy = props.status === "loading" || buffering || downloading;
  const wordNumber =
    props.currentWordIndex === null
      ? 0
      : Math.min(props.totalWords, props.currentWordIndex + 1);
  const progress = downloading
    ? (props.downloadProgress ?? 0) * 100
    : props.totalWords > 0
      ? (wordNumber / props.totalWords) * 100
      : 0;
  const downloadPercent = String(
    Math.round((props.downloadProgress ?? 0) * 100),
  );
  const voices = props.voices.filter((voice) => voice.lang === props.lang);
  const status =
    props.error ??
    (downloading
      ? t("downloadingVoice", `Downloading ${downloadPercent}%`, [
          downloadPercent,
        ])
      : undefined) ??
    props.notice ??
    (buffering
      ? t("buffering", "Buffering")
      : busy
      ? t("preparingVoice", "Preparing voice")
      : props.totalWords > 0
        ? t("wordProgress", `Word ${wordNumber} of ${props.totalWords}`, [
            String(wordNumber),
            String(props.totalWords),
          ])
        : t("readyToRead", "Ready to read"));

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target instanceof HTMLSelectElement) return;
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
      if (expanded) setExpanded(false);
      else props.onClose();
    }
  }

  return (
    <div
      className="player"
      role="region"
      aria-label={t("playerLabel", "Open Speechy player")}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      data-state={downloading || buffering ? "loading" : props.status}
    >
      <div className="player__bar">
        <div className="player__controls" aria-label="Playback controls">
          <IconButton
            label={t("previousSentence", "Previous sentence")}
            onClick={() => props.onControl("previous")}
          >
            <path d="M6 6h2v12H6zM9.5 12 18 18V6z" />
          </IconButton>
          <button
            className="player__play"
            type="button"
            aria-label={playing ? t("pause", "Pause") : t("play", "Play")}
            disabled={props.status === "error"}
            onClick={() => props.onControl("toggle")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {playing ? (
                <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" />
              ) : (
                <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />
              )}
            </svg>
          </button>
          <IconButton
            label={t("nextSentence", "Next sentence")}
            onClick={() => props.onControl("next")}
          >
            <path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z" />
          </IconButton>
        </div>

        <div className="player__copy" dir="auto">
          <strong className="player__title" title={props.title}>
            {props.title || "Open Speechy"}
          </strong>
          <span
            className={
              props.error ? "player__status player__status--error" : "player__status"
            }
            aria-live="polite"
            title={status}
          >
            {status}
          </span>
        </div>

        <button
          className="player__chip"
          type="button"
          aria-label={t("speedAndVoice", "Speed and voice")}
          aria-expanded={expanded}
          data-testid="settings-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {props.speed.toFixed(props.speed % 1 === 0 ? 0 : 1)}×
        </button>
        <IconButton
          className="player__close"
          label={t("closeReader", "Close reader")}
          onClick={props.onClose}
          stroke
        >
          <path d="M7 7l10 10M17 7 7 17" />
        </IconButton>
      </div>

      <div className="player__progress" aria-hidden="true">
        <span style={{ width: `${progress}%` }} />
      </div>

      {expanded && (
        <div className="player__panel">
          <div className="player__field">
            <div className="player__label">
              <span>{t("readingSpeed", "Reading speed")}</span>
              <span className="player__value">{props.speed.toFixed(1)}×</span>
            </div>
            <input
              type="range"
              min="0.5"
              max="3"
              step="0.1"
              value={props.speed}
              aria-label={t("readingSpeed", "Reading speed")}
              onChange={(event) =>
                props.onSpeed(Number(event.currentTarget.value))
              }
            />
            <div className="player__presets">
              {SPEED_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={Math.abs(props.speed - preset) < 0.05}
                  onClick={() => props.onSpeed(preset)}
                >
                  {preset}×
                </button>
              ))}
            </div>
          </div>
          <label className="player__field">
            <span className="player__label">{t("voice", "Voice")}</span>
            <select
              aria-label={t("readingVoice", "Reading voice")}
              value={props.voiceId}
              disabled={voices.length === 0}
              onChange={(event) => props.onVoice(event.currentTarget.value)}
            >
              {voices.length === 0 && <option value={props.voiceId}>…</option>}
              {voiceGroups(voices).map(([group, groupVoices]) => (
                <optgroup key={group} label={group}>
                  {groupVoices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voiceLabel(voice)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {props.status === "playing" && (
            <span className="player__drift" aria-live="off">
              {t("drift", "Drift")} {props.driftMs} ms
            </span>
          )}
        </div>
      )}

      {props.showJumpToCurrent && (
        <button
          className="player__jump"
          type="button"
          onClick={props.onJumpToCurrent}
        >
          {t("jumpToCurrent", "Jump to current")}
        </button>
      )}
    </div>
  );
}

function IconButton(props: {
  label: string;
  className?: string;
  stroke?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      className={props.className}
      type="button"
      aria-label={props.label}
      onClick={props.onClick}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={props.stroke ? "icon--stroke" : undefined}
      >
        {props.children}
      </svg>
    </button>
  );
}

function voiceGroups(voices: VoiceInfo[]): [string, VoiceInfo[]][] {
  const groups = new Map<string, VoiceInfo[]>();
  for (const voice of voices) {
    const group =
      voice.engineId === "system"
        ? t("groupSystemVoices", "System voices")
        : voice.engineId === "server"
          ? t("voiceLocalServer", "Local server")
          : t("voiceOnDevice", "On-device");
    groups.set(group, [...(groups.get(group) ?? []), voice]);
  }
  return [...groups];
}

function voiceLabel(voice: VoiceInfo): string {
  const detail =
    voice.engineId === "system"
      ? qualityLabel(voice)
      : (voice.description ?? qualityLabel(voice));
  return `${voice.name} · ${detail}`;
}

function qualityLabel(voice: VoiceInfo): string {
  if (voice.engineId === "system") {
    return voice.quality === "standard" || voice.quality === "compact"
      ? voice.supportsWordTimings
        ? t(voice.quality, voice.quality)
        : t("voiceNoWordEvents", "$1, no word events", [voice.quality])
      : t(voice.quality, voice.quality);
  }
  return voice.engineId === "server"
    ? t("voiceLocalServer", "Local server")
    : t("voiceOnDevice", "On-device");
}
