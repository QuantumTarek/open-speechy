import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Lang, VoiceInfo } from "../../engines/types";
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  type AppSettings,
} from "../../settings/store";
import { normalizeServerUrl } from "../../engines/server";
import "./options.css";

interface VoiceListResponse {
  ok?: boolean;
  voices?: VoiceInfo[];
  error?: string;
}

const settingsStore = new SettingsStore();

function OptionsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [notice, setNotice] = useState("");
  const [auditioning, setAuditioning] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SETTINGS.server.url);
  const [pairCode, setPairCode] = useState("");
  const [serverBusy, setServerBusy] = useState(false);
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
            Model engines remain disabled until their revisions and checksums
            pass the M0 verification.
          </p>
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
