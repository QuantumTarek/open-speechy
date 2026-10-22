# Manual QA

Record the browser version, OS, selected voice, and model revision with every
run. Do not report timing or pronunciation targets as passed without measuring
them on the target machine.

## M1 English article

- [ ] Read the bundled English fixture and verify article text only is spoken.
- [ ] Try three real pages: one Wikipedia article, one Medium post, and one
  news article.
- [ ] Verify each spoken word highlight by ear and with the drift readout.
- [ ] Pause, resume, seek by clicking a word, skip in both directions, and try
  speeds from 0.5x to 3x.
- [ ] Confirm the page content is unchanged after playback.

## Full product checklist

- [ ] English, Arabic, and mixed-language pages, including Arabic reading
  direction and word selection.
- [ ] A long article, an SPA that rerenders, infinite scroll, iframes, and a
  dark-mode site.
- [ ] Selection across paragraphs and each keyboard shortcut.
- [ ] English and Arabic PDFs, including a local file and a two-column paper.
- [ ] Google Docs in English and Arabic, plus a document with download disabled.
- [ ] Offline playback after model installation and browser restart mid-session.
- [ ] Starting a second tab stops the first.
- [ ] Apple Premium/Enhanced voices present and absent.
- [ ] Paired server authentication, cancellation, server shutdown fallback, and
  loopback-only binding.

## M0 measurements still open

- [ ] Kokoro and Piper real-time factor, time-to-first-audio, and pinned model
  checksums.
- [ ] Arabic diacritizer size, speed, and native-speaker accuracy.
- [ ] macOS `chrome.tts` word events and `charIndex` behavior.
- [ ] Offscreen `SharedArrayBuffer`, PDF redirect, and Arabic PDF ordering.
- [ ] Server engine speed and blind Arabic quality ratings.
- [ ] MMS_FA alignment error for English and Arabic.
