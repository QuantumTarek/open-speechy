# M0 spike findings

These spikes were run before implementation on 2026-10-22. The machine is Apple Silicon (`arm64`) with Chrome installed, Node 24.16.0, pnpm 11.22.0, and Python 3.14.7. `uv` and the project dependencies were not installed at spike time. Results below distinguish measured facts from decisions that still need device or human verification.

## Decisions

| # | Spike | Finding | Decision |
|---|---|---|---|
| 1 | Kokoro in an offscreen worker | Not measured. The extension worker and model are not installed yet, so WebGPU/WASM RTF, first-audio latency, timestamp tensor output, and its units remain unknown. | Use estimated timings until a real Kokoro export is tested. Keep WebGPU optional and prefer WASM when no measured faster backend is available. |
| 2 | Piper Kareem and espeak WASM | Not measured. No model or phonemizer package was present. | Keep duration timing on the estimated fallback. Package the phonemizer locally; do not start a model download until the checksums and extension-worker load path are validated. |
| 3 | Browser Arabic diacritizer | No candidate was tested for size, WASM speed, license, or accuracy. No native-speaker ratings are available. | Apply the plan's fallback: do not claim browser diacritization works; default it off until a candidate passes those checks. Prefer the server's Arabic engine or a verified local system voice. |
| 4 | macOS `chrome.tts` word events | Chrome is installed, but Premium English and Enhanced Arabic voices were not enumerated and no `word` event `charIndex` run was made. | Auto-select only a local system voice whose runtime metadata advertises `word` events. The audition panel and manual QA will capture per-voice behavior. |
| 5 | `SharedArrayBuffer` in offscreen | Not tested in an extension offscreen page. | Feature-detect `SharedArrayBuffer`; use single-threaded WASM if unavailable. Do not assume cross-origin isolation succeeded. |
| 6 | DNR PDF response-header redirect | Not tested in Chrome. The plan requires Chrome 128+ for response-header matching while the minimum target is 116. | Use a URL-suffix PDF rule only where supported, plus the popup PDF action. Keep response-header matching optional and version-gated. |
| 7 | PDF.js Arabic extraction order | No Arabic PDF fixtures were available during the spike. | Normalize presentation forms with NFKC, apply the documented reversal heuristic, and keep the limitation visible in manual QA. |
| 8 | Server models on MPS and CPU | SILMA, Kokoro, and Chatterbox weights and packages are absent. RTF, first-audio time, step-count quality, and blind Arabic ratings cannot be reported. | Keep SILMA as the planned Arabic server default and make step count configurable. Do not ship Chatterbox multilingual as the default without the requested blind comparison. Record quality ratings as pending human verification. |
| 9 | MMS_FA forced alignment | No torchaudio/PyTorch environment or sample audio was available. | Use estimated timings whenever alignment is unavailable or confidence is low. Validate alignment against Kokoro and Arabic samples before claiming the target drift. |

## Verification still required

- Browser-side benchmarks for Kokoro and Piper, with exact model revision, SHA-256, backend, RTF, and time-to-first-audio.
- Candidate diacritizer benchmark on 20 sentences and native Arabic pronunciation ratings.
- Premium English and Enhanced Arabic `chrome.tts` event traces, including `charIndex`.
- Offscreen `SharedArrayBuffer` feature test and PDF response-header redirect test.
- Arabic PDF ordering test on at least three real documents.
- SILMA, Kokoro, Chatterbox-Nano, and optional Chatterbox-Multilingual benchmark on MPS and CPU.
- Blind ratings for the 20 Arabic sentences and MMS_FA alignment error measurements.

A value marked "not measured" here must not be presented as a performance or quality result.

## Implementation follow-up

- Browser Kokoro uses `onnx-community/Kokoro-82M-v1.0-ONNX` at revision
  `1939ad2a8e416c0acfeecc08a694d14ef25f2231`, with q8 weights and per-voice
  embeddings. The extension verifies each file's SHA-256 before Transformers.js
  can read it.
- Browser Piper uses `rhasspy/piper-voices` at revision
  `5041a7a49ae5b3a0f30e6837769eb03fdbb231bd`. The pinned voice card points to
  `AliMokhammad/arabicttstrain` but does not state its license. The extension
  does not bundle the voice weights.
- The diacritizer implementation selects the 4.8 MB MIT libtashkeel ONNX mirror
  at revision `ee43300a96e8fec13d573699d993b76c1aacf983`. Its model size meets
  the spike budget, but WASM speed and pronunciation accuracy have not been
  measured. The setting remains off by default.
- These pins verify file identity, not synthesis speed, word timing, or voice
  quality. Keep the corresponding acceptance checks open until measured.
