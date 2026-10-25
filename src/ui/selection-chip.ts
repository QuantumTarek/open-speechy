import { AudioLines, createElement } from "lucide";
import { t } from "../i18n";

// Space between the selection and the button, and from the window's edges.
const GAP = 10;
const EDGE = 12;
const HEIGHT = 34;

const CHIP_CSS = `
  button {
    display: inline-flex;
    gap: 7px;
    align-items: center;
    height: ${HEIGHT}px;
    padding: 0 14px 0 11px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 999px;
    background: linear-gradient(135deg, #6b78f5, #3540b8);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.22),
      0 8px 22px rgba(53, 64, 184, 0.35),
      0 1px 3px rgba(20, 24, 80, 0.25);
    color: #ffffff;
    cursor: pointer;
    font: 600 12.5px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text",
      "Segoe UI", "Noto Sans Arabic", sans-serif;
    letter-spacing: 0.01em;
    white-space: nowrap;
    animation: appear 0.16s ease-out;
    transition: transform 0.12s ease, filter 0.12s ease, box-shadow 0.12s ease;
  }
  button[data-icon-only="true"] {
    justify-content: center;
    width: ${HEIGHT}px;
    padding: 0;
  }
  button:hover {
    filter: brightness(1.08);
    transform: translateY(-1px);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.22),
      0 10px 26px rgba(53, 64, 184, 0.42),
      0 1px 3px rgba(20, 24, 80, 0.25);
  }
  button:active { transform: translateY(0) scale(0.97); }
  button:focus-visible { outline: 2px solid #abb3fe; outline-offset: 3px; }
  svg { flex: none; width: 15px; height: 15px; }
  @keyframes appear {
    from { opacity: 0; transform: translateY(4px) scale(0.94); }
  }
  @media (prefers-reduced-motion: reduce) {
    button { animation: none; transition: none; }
    button:hover, button:active { transform: none; }
  }
`;

export class SelectionChip {
  readonly #document: Document;
  readonly #window: Window;
  readonly #onRead: () => void;
  #enabled: boolean;
  #iconOnly = false;
  #host: HTMLDivElement | null = null;
  #button: HTMLButtonElement | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    document: Document,
    window: Window,
    onRead: () => void,
    enabled: boolean,
  ) {
    this.#document = document;
    this.#window = window;
    this.#onRead = onRead;
    this.#enabled = enabled;
    this.#document.addEventListener(
      "selectionchange",
      this.#handleSelectionChange,
    );
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
    if (!enabled) this.#hide();
    else this.#scheduleUpdate();
  }

  setIconOnly(iconOnly: boolean): void {
    if (iconOnly === this.#iconOnly) return;
    this.#iconOnly = iconOnly;
    if (this.#button) this.#renderButton(this.#button);
  }

  hide(): void {
    this.#hide();
  }

  dispose(): void {
    this.#document.removeEventListener(
      "selectionchange",
      this.#handleSelectionChange,
    );
    this.#hide();
  }

  #handleSelectionChange = (): void => {
    this.#scheduleUpdate();
  };

  #scheduleUpdate(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#update();
    }, 80);
  }

  #update(): void {
    if (!this.#enabled) return this.#hide();
    const selection = this.#window.getSelection();
    if (!selection || selection.isCollapsed || selection.toString().trim().length < 20) {
      return this.#hide();
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return this.#hide();

    const host = this.#ensureHost();
    const left = Math.min(
      Math.max(EDGE, rect.left + rect.width / 2),
      Math.max(EDGE, this.#window.innerWidth - EDGE),
    );
    // Above the selection, or below it when there is no room above.
    const above = rect.top - GAP - HEIGHT;
    const top =
      above >= EDGE
        ? above
        : Math.min(rect.bottom + GAP, this.#window.innerHeight - EDGE - HEIGHT);
    host.style.left = `${left}px`;
    host.style.top = `${Math.max(EDGE, top)}px`;
  }

  #ensureHost(): HTMLDivElement {
    if (this.#host) return this.#host;
    const host = this.#document.createElement("div");
    host.setAttribute("data-open-speechy-selection-chip", "");
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;transform:translateX(-50%)";
    const shadow = host.attachShadow({ mode: "open" });
    const style = this.#document.createElement("style");
    style.textContent = CHIP_CSS;
    const button = this.#document.createElement("button");
    button.type = "button";
    this.#renderButton(button);
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", () => {
      this.#hide();
      this.#onRead();
    });
    shadow.append(style, button);
    this.#document.documentElement.append(host);
    this.#host = host;
    this.#button = button;
    return host;
  }

  #renderButton(button: HTMLButtonElement): void {
    const label = t("selectionChipRead", "Read selection");
    button.replaceChildren(
      createElement(AudioLines, { "aria-hidden": "true", "stroke-width": 2.25 }),
    );
    if (!this.#iconOnly) button.append(label);
    button.dataset.iconOnly = String(this.#iconOnly);
    // The page's direction is unknown here; follow the label's script.
    button.dir = /[؀-ۿ]/u.test(label) ? "rtl" : "ltr";
    button.title = this.#iconOnly ? label : "";
    button.setAttribute(
      "aria-label",
      t("selectionChipLabel", "Read selected text"),
    );
  }

  #hide(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#host?.remove();
    this.#host = null;
    this.#button = null;
  }
}
