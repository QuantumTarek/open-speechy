import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Lang, VoiceInfo } from "../../engines/types";
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  type AppSettings,
} from "../../settings/store";
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
  useEffect(() => {
    void Promise.all([
      settingsStore.load(),
      chrome.runtime.sendMessage({ type: "voices/list" }) as Promise<
        VoiceListResponse
      >,
    ])
      .then(([loaded, response]) => {
        setSettings(loaded);
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

      <footer className="footer">
        <span>Speech stays local.</span>
        <span>Build 0.1.0 / M2 voice routing</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<OptionsPage />);
