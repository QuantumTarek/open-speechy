import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Lang, VoiceInfo } from "../../engines/types";
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  type AppSettings,
  type SettingsPatch,
} from "../../settings/store";
import { normalizeServerUrl } from "../../engines/server";
import { MODEL_CATALOG, MODEL_DESCRIPTORS } from "../../models/catalog";
import { ModelManager, type ModelProgress } from "../../models/manager";
import "./options.css";

interface VoiceListResponse {
  ok?: boolean;
  voices?: VoiceInfo[];
  error?: string;
}

const settingsStore = new SettingsStore();
const modelManager = new ModelManager(MODEL_DESCRIPTORS);

interface ModelViewState {
  phase: "idle" | "checking" | "downloading" | "ready" | "error";
  loaded: number;
  total: number;
  error?: string;
}

function OptionsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [notice, setNotice] = useState("");
  const [auditioning, setAuditioning] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SETTINGS.server.url);
  const [pairCode, setPairCode] = useState("");
  const [serverBusy, setServerBusy] = useState(false);
  const [modelStates, setModelStates] = useState<Record<string, ModelViewState>>(
    {},
  );

  async function refreshModels(): Promise<void> {
    const states = await Promise.all(
      MODEL_CATALOG.map(async (model) => {
        try {
          const installed = await modelManager.isInstalled(model.id);
          return [
            model.id,
            {
              phase: installed ? "ready" : "idle",
              loaded: installed ? model.bytes : 0,
              total: model.bytes,
            },
          ] as const;
        } catch {
          return [
            model.id,
            {
              phase: "idle",
              loaded: 0,
              total: model.bytes,
            },
          ] as const;
        }
      }),
    );
    setModelStates(Object.fromEntries(states));
  }

  async function downloadModel(modelId: string): Promise<void> {
    setModelStates((current) => ({
      ...current,
      [modelId]: {
        phase: "downloading",
        loaded: 0,
        total: MODEL_CATALOG.find((model) => model.id === modelId)?.bytes ?? 0,
      },
    }));
    try {
      await modelManager.download(modelId, (progress: ModelProgress) => {
        setModelStates((current) => ({
          ...current,
          [modelId]: {
            phase: "downloading",
            loaded: progress.loaded,
            total: progress.total,
          },
        }));
      });
      await refreshModels();
      setNotice("Model verified and ready.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Model download failed.";
      setModelStates((current) => ({
        ...current,
        [modelId]: {
          phase: "error",
          loaded: 0,
          total: current[modelId]?.total ?? 0,
          error: message,
        },
      }));
      setNotice(message);
    }
  }

  async function deleteModel(modelId: string): Promise<void> {
    const modelIds =
      modelId === "kokoro-en-q8"
        ? MODEL_DESCRIPTORS.filter(
            (model) =>
              model.id === modelId || model.id.startsWith("kokoro-voice-"),
          ).map((model) => model.id)
        : [modelId];
    await Promise.all(modelIds.map((id) => modelManager.remove(id)));
    await refreshModels();
    setNotice("Model files removed from this device.");
  }

  useEffect(() => {
    void Promise.all([
      settingsStore.load(),
      chrome.runtime.sendMessage({ type: "voices/list" }) as Promise<
        VoiceListResponse
      >,
    ])
      .then(([loaded, response]) => {
        setSettings(loaded);
        setServerUrl(loaded.server.url);
        if (response.ok && response.voices) setVoices(response.voices);
        else setNotice(response.error ?? "Voice discovery failed.");
        void refreshModels();
      })
      .catch((error: unknown) => {
        setNotice(
          error instanceof Error ? error.message : "Settings could not load.",
        );
      });
  }, []);

  async function selectVoice(lang: Lang, voiceId: string): Promise<void> {
    const updated = await settingsStore.update({ voice: { [lang]: voiceId } });
    setSettings(updated);
    setNotice("Voice preference saved.");
  }

  async function audition(voice: VoiceInfo): Promise<void> {
    setAuditioning(voice.id);
    setNotice(`Playing ${voice.name}...`);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "voice/audition",
        voiceId: voice.id,
      })) as { ok?: boolean; error?: string };
      setNotice(
        response.ok
          ? `${voice.name} sample finished.`
          : response.error ?? "Voice audition failed.",
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Voice audition failed.",
      );
    } finally {
      setAuditioning(null);
    }
  }

  async function pairServer(): Promise<void> {
    setServerBusy(true);
    setNotice("Connecting to the loopback server...");
    try {
      const url = normalizeServerUrl(serverUrl);
      const response = await fetch(`${url}/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairCode.trim() }),
      });
      const result = (await response.json()) as {
        token?: string;
        detail?: string;
      };
      if (!response.ok || !result.token) {
        throw new Error(result.detail ?? "Pairing failed. Check the code.");
      }
      const updated = await settingsStore.update({
        server: { enabled: true, url, token: result.token },
      });
      setSettings(updated);
      setPairCode("");
      await refreshVoices();
      setNotice(
        "Paired. The server token is stored on this device, not synced.",
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not pair the server.",
      );
    } finally {
      setServerBusy(false);
    }
  }

  async function refreshVoices(): Promise<void> {
    const response = (await chrome.runtime.sendMessage({
      type: "voices/list",
    })) as VoiceListResponse;
    if (response.ok && response.voices) setVoices(response.voices);
    else throw new Error(response.error ?? "Could not refresh voices.");
  }

  async function saveSettings(patch: SettingsPatch): Promise<void> {
    const updated = await settingsStore.update(patch);
    setSettings(updated);
    setNotice("Preferences saved.");
  }

  async function disconnectServer(): Promise<void> {
    const updated = await settingsStore.update({
      server: { token: "", enabled: false },
    });
    setSettings(updated);
    setVoices((current) => current.filter((voice) => voice.engineId !== "server"));
    setNotice("Local server disconnected.");
  }

  return (
    <main className="options">
      <header className="masthead">
        <div>
          <p className="kicker">OPEN SPEECHY / LOCAL AUDIO</p>
          <h1>Voices, tuned to you.</h1>
          <p className="lede">
            Choose a voice for each language. Page text stays in this browser;
            system voices and installed models do the talking.
          </p>
        </div>
        <span className="seal" aria-hidden="true">
          OS
        </span>
      </header>

      <section className="section" aria-labelledby="voice-heading">
        <div className="section__heading">
          <span className="section__number">01</span>
          <div>
            <h2 id="voice-heading">Voice preference</h2>
            <p>Auto mode picks a local Premium or Enhanced system voice first.</p>
          </div>
        </div>

        <div className="language-grid">
          {(["en", "ar"] as const).map((lang) => (
            <label className="language-card" key={lang}>
              <span className="language-card__lang">
                {lang === "en" ? "English" : "العربية"}
              </span>
              <select
                value={settings.voice[lang]}
                aria-label={`${lang === "en" ? "English" : "Arabic"} voice`}
                onChange={(event) =>
                  void selectVoice(lang, event.currentTarget.value)
                }
              >
                <option value="auto">Automatic</option>
                {voices
                  .filter((voice) => voice.lang === lang)
                  .map((voice) => (
                    <option value={voice.id} key={voice.id}>
                      {voice.name} / {voice.quality}
                      {!voice.installed ? " / model not installed" : ""}
                    </option>
                  ))}
              </select>
            </label>
          ))}
        </div>

        <aside className="help-note">
          <strong>On macOS</strong>
          <p>
            For a higher-quality system voice, open System Settings → Accessibility
            → Spoken Content → System Voice → Manage Voices. Download a Premium
            English voice or an Enhanced Arabic voice, then restart Chrome.
            Siri voices are not exposed to Chrome.
          </p>
        </aside>
      </section>

      <section className="section" aria-labelledby="audition-heading">
        <div className="section__heading">
          <span className="section__number">02</span>
          <div>
            <h2 id="audition-heading">Audition voices</h2>
            <p>Each available system voice reads the same short sample.</p>
          </div>
        </div>

        <div className="voice-list">
          {voices.map((voice) => (
            <article className="voice-row" key={voice.id}>
              <div>
                <div className="voice-row__title">
                  <strong>{voice.name}</strong>
                  <span className={`badge badge--${voice.quality}`}>
                    {voice.quality}
                  </span>
                </div>
                <p>
                  {voice.lang === "en" ? "English" : "Arabic"} ·{" "}
                  {voice.engineId === "system"
                    ? voice.local
                      ? "System voice"
                      : "Remote system voice"
                    : voice.engineId === "server"
                      ? "Local server"
                      : "On-device model"}
                  {voice.supportsWordTimings ? " · word events" : ""}
                </p>
              </div>
              <button
                type="button"
                disabled={
                  auditioning !== null ||
                  voice.engineId === "server" ||
                  (voice.engineId !== "system" && !voice.installed)
                }
                onClick={() => void audition(voice)}
              >
                {auditioning === voice.id ? "Playing..." : "Play sample"}
              </button>
            </article>
          ))}
          {voices.length === 0 && (
            <p className="empty-state">No voices were reported by Chrome.</p>
          )}
        </div>
        <p className="notice" role="status" aria-live="polite">
          {notice}
        </p>
      </section>

      <section className="section" aria-labelledby="server-heading">
        <div className="section__heading">
          <span className="section__number">03</span>
          <div>
            <h2 id="server-heading">Local companion server</h2>
            <p>Optional voice processing stays on 127.0.0.1.</p>
          </div>
        </div>

        <div className="server-panel">
          <label className="setting-row setting-row--compact">
            <span>
              <strong>Use the local server when paired</strong>
              <small>Disable this to use only browser and system voices.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.server.enabled}
              onChange={(event) =>
                void saveSettings({
                  server: { enabled: event.currentTarget.checked },
                })
              }
            />
          </label>
          <div className="server-panel__state">
            <span
              className={
                settings.server.token
                  ? "server-light server-light--on"
                  : "server-light"
              }
              aria-hidden="true"
            />
            <div>
              <strong>
                {settings.server.token ? "Paired on this device" : "Not paired"}
              </strong>
              <p>
                {settings.server.token
                  ? "The token is held in local extension storage."
                  : "Open the local pairing page, then enter its one-time code."}
              </p>
            </div>
          </div>

          <label className="server-field">
            <span>Server address</span>
            <input
              value={serverUrl}
              spellCheck={false}
              onChange={(event) => setServerUrl(event.currentTarget.value)}
            />
          </label>

          <div className="pair-row">
            <a
              href="http://127.0.0.1:5123/pair"
              target="_blank"
              rel="noreferrer"
            >
              Open pairing page
            </a>
            <label className="server-field">
              <span>One-time code</span>
              <input
                inputMode="numeric"
                maxLength={6}
                value={pairCode}
                onChange={(event) => setPairCode(event.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              disabled={serverBusy || pairCode.trim().length !== 6}
              onClick={() => void pairServer()}
            >
              {serverBusy ? "Connecting..." : "Pair server"}
            </button>
          </div>

          {settings.server.token && (
            <div className="server-panel__footer">
              <span>
                {voices.some((voice) => voice.engineId === "server")
                  ? "Server voices are ready."
                  : "Paired, but no verified server voice is available."}
              </span>
              <button type="button" onClick={() => void disconnectServer()}>
                Disconnect
              </button>
            </div>
          )}
          <p className="server-footnote">
            The server only accepts extension requests from its paired browser.
            Models download from pinned revisions on first use.
          </p>
        </div>
      </section>

      <section className="section" aria-labelledby="reading-heading">
        <div className="section__heading">
          <span className="section__number">04</span>
          <div>
            <h2 id="reading-heading">Reading behavior</h2>
            <p>Set how the reader handles page text, motion, and local models.</p>
          </div>
        </div>

        <div className="settings-grid">
          <label className="setting-row">
            <span>
              <strong>Auto-scroll</strong>
              <small>Keep the current word in view while reading.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.autoScroll}
              onChange={(event) =>
                void saveSettings({ autoScroll: event.currentTarget.checked })
              }
            />
          </label>
          <label className="setting-row">
            <span>
              <strong>Selection chip</strong>
              <small>Show a read button next to selections over 20 characters.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.selectionChip}
              onChange={(event) =>
                void saveSettings({ selectionChip: event.currentTarget.checked })
              }
            />
          </label>
          <label className="setting-row">
            <span>
              <strong>Read code blocks</strong>
              <small>Include preformatted code in article extraction.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.readCodeBlocks}
              onChange={(event) =>
                void saveSettings({ readCodeBlocks: event.currentTarget.checked })
              }
            />
          </label>
          <label className="setting-row">
            <span>
              <strong>Arabic diacritization</strong>
              <small>Experimental local model; disabled until benchmarked.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.arabic.diacritize}
              onChange={(event) =>
                void saveSettings({
                  arabic: { diacritize: event.currentTarget.checked },
                })
              }
            />
          </label>
          <label className="setting-control">
            <span>URL reading</span>
            <select
              value={settings.urls}
              onChange={(event) =>
                void saveSettings({
                  urls: event.currentTarget.value as AppSettings["urls"],
                })
              }
            >
              <option value="skip">Skip URLs</option>
              <option value="domain">Read domain only</option>
              <option value="full">Read full URL</option>
            </select>
          </label>
          <label className="setting-control">
            <span>Speed</span>
            <div className="range-setting">
              <input
                type="range"
                min="0.5"
                max="3"
                step="0.1"
                value={settings.speed}
                onChange={(event) =>
                  void saveSettings({ speed: Number(event.currentTarget.value) })
                }
              />
              <output>{settings.speed.toFixed(1)}×</output>
            </div>
          </label>
          <label className="setting-control">
            <span>Queued sentences</span>
            <select
              value={settings.lookahead}
              onChange={(event) =>
                void saveSettings({ lookahead: Number(event.currentTarget.value) })
              }
            >
              {[1, 2, 3, 4].map((count) => (
                <option value={count} key={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <label className="setting-control">
            <span>Unload idle audio engine</span>
            <div className="range-setting">
              <input
                type="range"
                min="1"
                max="30"
                step="1"
                value={settings.idleUnloadMinutes}
                onChange={(event) =>
                  void saveSettings({
                    idleUnloadMinutes: Number(event.currentTarget.value),
                  })
                }
              />
              <output>{settings.idleUnloadMinutes} min</output>
            </div>
          </label>
          <label className="setting-row">
            <span>
              <strong>PDF interception</strong>
              <small>Open PDF links in the local reader when supported.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.pdf.intercept}
              onChange={(event) =>
                void saveSettings({
                  pdf: { intercept: event.currentTarget.checked },
                })
              }
            />
          </label>
          <label className="setting-row">
            <span>
              <strong>Word and sentence highlights</strong>
              <small>Keep timing colors visible while the page is read.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.highlight.enabled}
              onChange={(event) =>
                void saveSettings({
                  highlight: { enabled: event.currentTarget.checked },
                })
              }
            />
          </label>
          <label className="setting-control">
            <span>Word highlight color</span>
            <input
              type="color"
              value={colorToHex(settings.highlight.word, "#ffb300")}
              onChange={(event) =>
                void saveSettings({
                  highlight: {
                    word: hexToRgba(event.currentTarget.value, 0.6),
                  },
                })
              }
            />
          </label>
          <label className="setting-control">
            <span>Sentence highlight color</span>
            <input
              type="color"
              value={colorToHex(settings.highlight.sentence, "#ffd54f")}
              onChange={(event) =>
                void saveSettings({
                  highlight: {
                    sentence: hexToRgba(event.currentTarget.value, 0.25),
                  },
                })
              }
            />
          </label>
        </div>
      </section>

      <section className="section" aria-labelledby="models-heading">
        <div className="section__heading">
          <span className="section__number">05</span>
          <div>
            <h2 id="models-heading">Models on this device</h2>
            <p>Weights stay in local Cache Storage and are checked before use.</p>
          </div>
        </div>
        <div className="model-list">
          {MODEL_CATALOG.map((model) => {
            const state = modelStates[model.id] ?? {
              phase: "checking" as const,
              loaded: 0,
              total: model.bytes,
            };
            const title =
              model.id === "kokoro-en-q8"
                ? "Kokoro English (q8)"
                : model.id === "piper-ar-kareem-medium"
                  ? "Piper Kareem, Arabic"
                  : "libtashkeel Arabic diacritizer";
            const ready = state.phase === "ready";
            const downloading = state.phase === "downloading";
            const percentage =
              state.total > 0
                ? Math.min(100, Math.round((state.loaded / state.total) * 100))
                : 0;
            return (
              <article className="model-row" key={model.id}>
                <div className="model-row__copy">
                  <div className="model-row__title">
                    <strong>{title}</strong>
                    <span className={`model-state model-state--${state.phase}`}>
                      {ready
                        ? "Ready"
                        : downloading
                          ? `${percentage}%`
                          : state.phase === "error"
                            ? "Error"
                            : "Not downloaded"}
                    </span>
                  </div>
                  <p>{formatBytes(model.bytes)} · {model.license}</p>
                  {model.id === "kokoro-en-q8" && (
                    <p>Voice embeddings download when a voice is first used.</p>
                  )}
                  {state.error && <p className="model-error">{state.error}</p>}
                  {downloading && (
                    <progress max={state.total} value={state.loaded} />
                  )}
                </div>
                <button
                  type="button"
                  disabled={downloading || state.phase === "checking"}
                  onClick={() =>
                    void (ready
                      ? deleteModel(model.id)
                      : downloadModel(model.id))
                  }
                >
                  {downloading
                    ? "Downloading..."
                    : ready
                      ? "Delete"
                      : state.phase === "error"
                        ? "Retry"
                        : "Download"}
                </button>
              </article>
            );
          })}
        </div>
      </section>

      <footer className="footer">
        <span>Speech stays local.</span>
        <span>Build 0.1.0 / local-first speech</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<OptionsPage />);

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function colorToHex(value: string, fallback: string): string {
  if (/^#[\da-f]{6}$/iu.test(value)) return value;
  const channels = value.match(/[\d.]+/gu)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) return fallback;
  return `#${channels
    .map((channel) =>
      Math.min(255, Math.max(0, Math.round(channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function hexToRgba(value: string, alpha: number): string {
  const channels = value
    .replace("#", "")
    .match(/.{2}/gu)
    ?.map((channel) => Number.parseInt(channel, 16));
  if (!channels || channels.length !== 3 || channels.some(Number.isNaN)) {
    return DEFAULT_SETTINGS.highlight.word;
  }
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
}
