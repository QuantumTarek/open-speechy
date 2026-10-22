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
  extension HTTP client with a next-sentence fallback path.

## Still blocked on measurements or implementation

- Kokoro is unavailable until its model files have pinned revisions and
  verified SHA-256 values. The current manifest intentionally blocks download.
- M0 still needs device-specific system voice event traces. M3 server model
  adapters remain gated because no revision, checksum, or timing data was
  measured. The API tests need the optional Python dependencies to run. M4
  through M8 remain in progress. `docs/qa.md` lists the manual checks that still
  need a browser, local models, or a native Arabic speaker.
