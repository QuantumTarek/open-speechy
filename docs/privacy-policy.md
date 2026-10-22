# Open Speechy — Privacy Policy

Open Speechy reads web text aloud using on-device speech engines.

## What we collect

Nothing. Open Speechy has no analytics, no telemetry, no accounts, and no
remote logging. The developers receive no data of any kind.

## Where your text goes

- Text extracted from pages, selections, PDFs, and Google Docs stays on
  your device. It is processed by in-browser engines or, if you pair it,
  by the companion server bound to `127.0.0.1` on your own machine.
- The companion server binds to localhost only, requires a bearer token
  generated on your device, and never logs the text it synthesizes.

## Network requests

The extension makes network requests only to:

- Hugging Face, to download the pinned model files listed in
  `src/models/models.json` (each file is SHA-256 verified before use).
- `docs.google.com`, to export a document you explicitly ask it to read
  (same-origin, using your own session).
- The configured localhost companion server, when paired.
- PDF documents you open in the viewer.

No text is sent to any third party.

## Storage

Settings are kept in `chrome.storage.sync`. Downloaded model weights are
cached locally on your device. Nothing is transmitted off the machine.
