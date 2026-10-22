# Milestone status

## Done

- M0 recorded the spike results and used the documented fallbacks where checks
  could not run.
- M1 implements English article extraction, segmentation, an estimated timing
  fallback, the Web Audio sentence queue, CSS Custom Highlights, and the
  floating player.
- The E2E build uses a deterministic silent engine and Playwright's bundled
  Chromium. It checks highlight progress, click-to-seek, pause, and article DOM
  preservation.
- M2 discovers `chrome.tts` voices, selects only local Premium/Enhanced voices
  with word events in auto mode, and exposes voice preferences and auditions in
  the options page. The service worker runs system speech and forwards word
  events to the content highlighter.
- M3 adds the loopback API, bearer-token auth, one-time extension pairing,
  per-engine request serialization/cancellation, install scripts, and the
  extension HTTP client with a next-sentence fallback path. Kokoro, SILMA,
  Chatterbox-Nano, and Chatterbox-Multilingual now have lazy adapters that use
  pinned Hugging Face revisions. MMS_FA alignment falls back to estimated
  timings when it is missing or uncertain.
- M4 text preparation handles Arabic digits, tatweel, number words, and mixed
  English/Arabic word runs. M4.2 pins the browser Kokoro, Piper, and libtashkeel
  files, adds VITS inference with the bundled eSpeak-NG WASM phonemizer, and
  wires the Arabic ONNX predictor behind the existing setting. Diacritization
  remains off pending speed and pronunciation checks.

## Still blocked on measurements or implementation

- Per-language mixed-script routing remains in progress. The Piper Kareem
  model card still does not state the training dataset license, so do not
  redistribute its weights until that is confirmed.
- M0 still needs system voice event traces, browser/server timing benchmarks,
  Arabic PDF ordering checks, and native-speaker pronunciation ratings. The
  server adapters are implemented, but those measurements are not claimed.
- M5 through M8 remain in progress. `docs/qa.md` lists the manual checks that
  still need a browser, local models, or a native Arabic speaker.
