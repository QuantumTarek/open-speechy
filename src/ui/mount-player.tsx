import { createRoot, type Root } from "react-dom/client";
import { PlayerBar, type PlayerBarProps } from "./PlayerBar";

const PLAYER_CSS = `
  :host {
    all: initial;
    color-scheme: light;
    position: fixed;
    z-index: 2147483647;
    left: 50%;
    bottom: 18px;
    width: min(760px, calc(100vw - 28px));
    transform: translateX(-50%);
    font-family: "Avenir Next", "Trebuchet MS", sans-serif;
    color: #193238;
  }
  * { box-sizing: border-box; }
  .player {
    display: grid;
    grid-template-columns: minmax(130px, 1fr) auto minmax(98px, 132px) auto auto;
    align-items: center;
    gap: 14px;
    padding: 12px 14px 12px 18px;
    border: 1px solid rgba(25, 50, 56, 0.18);
    border-radius: 15px;
    background: rgba(250, 247, 238, 0.97);
    box-shadow: 0 12px 36px rgba(10, 29, 34, 0.22);
    backdrop-filter: blur(16px);
    outline: none;
  }
  .player:focus-visible {
    box-shadow: 0 0 0 3px #e6a14a, 0 12px 36px rgba(10, 29, 34, 0.22);
  }
  .player__copy { display: grid; min-width: 0; gap: 2px; }
  .player__eyebrow {
    color: #57716f;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.13em;
  }
  .player__title {
    overflow: hidden;
    color: #193238;
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    font-size: 15px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .player__status { color: #657779; font-size: 11px; }
  .player__controls { display: flex; align-items: center; gap: 6px; }
  button {
    display: inline-grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: #193238;
    cursor: pointer;
    font: 600 13px "Avenir Next", "Trebuchet MS", sans-serif;
  }
  button:hover { background: #e9e4d6; }
  button:focus-visible, input:focus-visible {
    outline: 2px solid #ba6b35;
    outline-offset: 2px;
  }
  button:disabled { cursor: wait; opacity: 0.55; }
  .player .player__play {
    width: 38px;
    height: 38px;
    background: #193238;
    color: #fffaf0;
    font-size: 15px;
  }
  .player__play:hover { background: #2a5055; }
  .player__speed { display: grid; gap: 3px; color: #314d50; font-size: 11px; }
  .player__speed input { width: 100%; accent-color: #ba6b35; }
  .player__drift { min-width: 74px; color: #73827d; font-size: 10px; }
  .player__close { width: 28px; height: 28px; font-size: 20px; }
  @media (max-width: 560px) {
    :host { bottom: 10px; width: calc(100vw - 18px); }
    .player {
      grid-template-columns: 1fr auto auto;
      gap: 8px;
      padding: 10px 10px 10px 13px;
    }
    .player__controls { grid-column: 2; grid-row: 1; }
    .player__speed { grid-column: 1 / 3; grid-row: 2; grid-template-columns: 36px 1fr; align-items: center; }
    .player__drift { display: none; }
    .player__close { grid-column: 3; grid-row: 1; }
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
