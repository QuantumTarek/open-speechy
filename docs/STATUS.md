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
  wires the Arabic ONNX predictor behind the existing setting. M4.3 routes each
  sentence to its language's server or browser engine and adds Arabic and mixed
  fixtures. The deterministic e2e test verifies the word sequence and DOM
  preservation. Diacritization remains off pending speed and pronunciation
  checks.
- M5.1 adds the toolbar popup, a selection chip for long text selections, and
  settings for voice, speed, URL handling, highlight preferences, model
  downloads, server pairing, and reading behavior. The selected-text e2e test
  starts reading through the chip and checks that the article DOM is unchanged.
- M5.2 localizes the UI through `_locales` message files (en/ar), swaps in the
  dark-page highlight palette when the article background is dark, pauses
  auto-scroll after manual scrolling with a "Jump to current" pill, rebinds
  word pieces after DOM mutations via `src/text/rebind.ts`, unloads the
  offscreen document after `idleUnloadMinutes`, and restarts a session from
  storage when the offscreen document was reclaimed.

## Still blocked on measurements or implementation

- Per-language mixed-script routing remains in progress. The Piper Kareem
  model card still does not state the training dataset license, so do not
  redistribute its weights until that is confirmed.
- M0 still needs system voice event traces, browser/server timing benchmarks,
  Arabic PDF ordering checks, and native-speaker pronunciation ratings. The
  server adapters and mixed-language routing are implemented, but real model
  gap timings and pronunciation results are not claimed.
- M5.2 is implemented.
- M6 adds the PDF.js viewer (`pdf-viewer.html`): lazy canvas rendering with a
  transparent positioned text layer, line grouping, up-to-three-column
  detection with RTL column order for Arabic pages, paragraph joining by
  vertical gap, running header/footer and page-number filtering, English
  line-end de-hyphenation, and Arabic presentation-form folding plus
  visual-order run reversal. A `declarativeNetRequest` rule redirects
  `.pdf` main-frame navigations into the viewer while `pdf.intercept` is on,
  and the popup shows "Read this PDF" for PDF tabs. Session events reach
  extension pages through `tabs.sendMessage` with a `targetTabId` broadcast
  fallback. Generated `sample-en.pdf` (two columns, two pages, boilerplate,
  hyphenation) and `sample-ar.pdf` (visual-order presentation forms) cover the
  pipeline in e2e; a real 2-column paper and real Arabic PDFs are still manual
  checks.
- M7 adds the Reader view (reader.html) for sanitized HTML and pasted
  text, and the Google Docs export flow: "Read this document" fetches the
  doc's export with the user session into the reader, with a paste
  fallback when export is disabled. e2e covers both paths.
- M8: production build and `pnpm zip` verified (26 MB store zip),
  privacy policy written, store screenshots generated, server version
  update notice wired in options, README install instructions added.
  A real store listing, real Google Docs check, and tagged server release
  remain manual steps.
