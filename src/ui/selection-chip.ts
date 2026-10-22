export class SelectionChip {
  readonly #document: Document;
  readonly #window: Window;
  readonly #onRead: () => void;
  #enabled: boolean;
  #host: HTMLDivElement | null = null;
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
      Math.max(12, rect.left + rect.width / 2),
      Math.max(12, this.#window.innerWidth - 12),
    );
    const top = Math.max(12, rect.top - 48);
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
  }

  #ensureHost(): HTMLDivElement {
    if (this.#host) return this.#host;
    const host = this.#document.createElement("div");
    host.setAttribute("data-open-speechy-selection-chip", "");
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;transform:translateX(-50%)";
    const shadow = host.attachShadow({ mode: "open" });
    const style = this.#document.createElement("style");
    style.textContent = `
      button {
        border: 1px solid rgba(25, 50, 56, 0.2);
        border-radius: 999px;
        padding: 8px 13px;
        background: #193238;
        box-shadow: 0 5px 18px rgba(10, 29, 34, 0.2);
        color: #fffaf0;
        cursor: pointer;
        font: 600 12px "Avenir Next", "Trebuchet MS", sans-serif;
      }
      button:focus-visible { outline: 2px solid #e6a14a; outline-offset: 2px; }
    `;
    const button = this.#document.createElement("button");
    button.type = "button";
    button.textContent = "▶ Read selection";
    button.setAttribute("aria-label", "Read selected text");
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
    return host;
  }

  #hide(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#host?.remove();
    this.#host = null;
  }
}
