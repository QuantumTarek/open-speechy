# Third-party licenses

Open Speechy will be distributed under GPL-3.0-or-later. Model files download
to the user's device and are not bundled in the extension archive.

| Component | License | Source and notes |
|---|---|---|
| Kokoro-82M model | Apache-2.0 | [HF model card](https://huggingface.co/hexgrad/Kokoro-82M) |
| Kokoro ONNX export | Apache-2.0 | [HF model card](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) |
| SILMA-TTS weights | Apache-2.0 | [HF model card](https://huggingface.co/silma-ai/silma-tts) |
| SILMA-TTS Python package | MIT | [PyPI project](https://pypi.org/project/silma-tts/) |
| Vocos-Mel-24kHz | MIT | [HF model card](https://huggingface.co/charactr/vocos-mel-24khz) |
| Chatterbox-Nano | MIT | [HF model card](https://huggingface.co/ResembleAI/chatterbox-nano) |
| Chatterbox Multilingual | MIT | [HF model card](https://huggingface.co/ResembleAI/chatterbox) |
| Chatterbox Python code | MIT | [Upstream repository](https://github.com/resemble-ai/chatterbox) |
| libtashkeel ONNX weights | MIT | [HF model card](https://huggingface.co/TigreGotico/libtashkeel-diacritizer), mirrored from Musharraf Omer's MIT project |
| Piper `ar_JO-kareem-medium` voice | Unclear | Its [model card](https://huggingface.co/rhasspy/piper-voices/tree/main/ar/ar_JO/kareem/medium) says to see the training dataset at [arabicttstrain](https://github.com/AliMokhammad/arabicttstrain), but that repository does not publish a license file. Do not redistribute this voice until its license is confirmed. |
| Piper phonemizer WebAssembly wrapper | MIT | [@diffusionstudio/piper-wasm](https://www.npmjs.com/package/@diffusionstudio/piper-wasm); it bundles eSpeak-NG, which is GPL-3.0-or-later |
| Piper / Kokoro phonemizer dependency | GPL-3.0-or-later | eSpeak-NG; it is why this project is GPL-3.0-or-later. |
| MMS_FA runtime | BSD-3-Clause | torchaudio/PyTorch runtime. The MMS_FA checkpoint license still needs a release review. |

The extension verifies SHA-256 for its Hugging Face model files before use.
Server model revisions are pinned in `server/models.json`; the server downloads
only the files needed by each adapter. Recheck upstream license notices before
publishing a Chrome Web Store build or a server release.
