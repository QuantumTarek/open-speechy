import { createRoot, type Root } from "react-dom/client";
import { PlayerBar, type PlayerBarProps } from "./PlayerBar";

const PLAYER_CSS = `
  :host {
    all: initial;
    --bg: rgba(255, 252, 245, 0.96);
    --fg: #17292d;
    --muted: #64777a;
    --line: rgba(23, 41, 45, 0.12);
    --hover: rgba(23, 41, 45, 0.07);
    --accent: #c0632f;
    --solid: #17292d;
    --on-solid: #fffaf0;
    --danger: #b3261e;
    color-scheme: light;
    direction: ltr;
    position: fixed;
    z-index: 2147483647;
    top: 16px;
    right: 16px;
    width: 300px;
    max-width: calc(100vw - 16px);
    font: 13px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Noto Sans Arabic", sans-serif;
    color: var(--fg);
  }
  @media (prefers-color-scheme: dark) {
    :host {
      --bg: rgba(28, 34, 36, 0.96);
      --fg: #eef2ef;
      --muted: #9cabaa;
      --line: rgba(255, 255, 255, 0.12);
      --hover: rgba(255, 255, 255, 0.08);
      --accent: #f0a46b;
      --solid: #eef2ef;
      --on-solid: #17292d;
      --danger: #ff8a80;
      color-scheme: dark;
    }
  }
  * { box-sizing: border-box; }
  .player {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--bg);
    box-shadow: 0 10px 30px rgba(8, 24, 28, 0.18), 0 1px 3px rgba(8, 24, 28, 0.12);
    backdrop-filter: blur(14px) saturate(1.4);
    outline: none;
  }
  .player:focus-visible { box-shadow: 0 0 0 3px var(--accent), 0 10px 30px rgba(8, 24, 28, 0.18); }
  .player__bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 8px 6px;
  }
  .player__controls { display: flex; flex: none; align-items: center; gap: 0; }
  button {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    font: inherit;
  }
  button:hover { background: var(--hover); }
  button:focus-visible, input:focus-visible, select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  svg { width: 16px; height: 16px; fill: currentColor; }
  svg.icon--stroke { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
  .player .player__play {
    width: 34px;
    height: 34px;
    margin: 0 2px;
    border-radius: 50%;
    background: var(--solid);
    color: var(--on-solid);
  }
  .player .player__play:hover { opacity: 0.88; }
  .player__play svg { width: 18px; height: 18px; }
  .player__play:disabled { cursor: not-allowed; opacity: 0.4; }
  .player[data-state="loading"] .player__play { position: relative; }
  .player[data-state="loading"] .player__play::after {
    content: "";
    position: absolute;
    inset: -3px;
    border: 2px solid transparent;
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .player__copy { display: grid; flex: 1; min-width: 0; gap: 1px; }
  .player__title, .player__status {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .player__title { font-size: 12.5px; font-weight: 600; }
  .player__status { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .player__status--error { color: var(--danger); white-space: normal; }
  .player .player__chip {
    width: auto;
    min-width: 38px;
    height: 24px;
    padding: 0 7px;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .player__chip[aria-expanded="true"] { border-color: var(--accent); color: var(--accent); }
  .player .player__close { width: 24px; height: 24px; color: var(--muted); }
  .player__close svg { width: 14px; height: 14px; }
  .player__progress { height: 2px; background: var(--line); }
  .player__progress span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.25s ease;
  }
  .player__panel {
    display: grid;
    gap: 12px;
    padding: 12px 12px 10px;
    border-top: 1px solid var(--line);
  }
  .player__field { display: grid; gap: 6px; }
  .player__label {
    display: flex;
    justify-content: space-between;
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
  }
  .player__value { color: var(--fg); font-variant-numeric: tabular-nums; }
  .player__field input[type="range"] { width: 100%; margin: 0; accent-color: var(--accent); }
  .player__presets { display: flex; gap: 4px; }
  .player .player__presets button {
    flex: 1;
    width: auto;
    height: 24px;
    border: 1px solid var(--line);
    border-radius: 6px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .player__presets button[aria-pressed="true"] {
    border-color: var(--solid);
    background: var(--solid);
    color: var(--on-solid);
  }
  .player__field select {
    width: 100%;
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: 12px;
  }
  .player__drift { color: var(--muted); font-size: 10px; text-align: end; }
  .player .player__jump {
    display: block;
    width: calc(100% - 16px);
    height: 26px;
    margin: 0 8px 8px;
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--accent);
    font-size: 11.5px;
    font-weight: 600;
  }
  @media (max-width: 480px) {
    :host { top: 8px; right: 8px; width: calc(100vw - 16px); }
  }
  @media (prefers-reduced-motion: reduce) {
    .player__progress span { transition: none; }
    .player[data-state="loading"] .player__play::after { animation-duration: 2.4s; }
  }
`;

export interface MountedPlayer {
  update(props: PlayerBarProps): void;
  unmount(): void;
}

export function mountPlayer(
  document: Document,
  initialProps: PlayerBarProps,
): MountedPlayer {
  const host = document.createElement("div");
  host.id = "open-speechy-player";
  host.setAttribute("aria-label", "Open Speechy");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = PLAYER_CSS;
  const mountPoint = document.createElement("div");
  shadow.append(style, mountPoint);
  document.documentElement.append(host);

  const root: Root = createRoot(mountPoint);
  root.render(<PlayerBar {...initialProps} />);
  return {
    update(props) {
      root.render(<PlayerBar {...props} />);
    },
    unmount() {
      root.unmount();
      host.remove();
    },
  };
}
