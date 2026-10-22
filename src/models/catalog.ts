import modelManifest from "./models.json";
import { KOKORO_VOICES } from "../engines/voice-catalog";
import type { ModelDescriptor } from "./manager";

const models = modelManifest.models as ModelDescriptor[];
const kokoroModel = models.find((model) => model.id === "kokoro-en-q8");
const kokoroVoices = modelManifest.kokoroVoices as Record<
  string,
  { sha256: string; bytes: number }
>;

export const MODEL_DESCRIPTORS: ModelDescriptor[] = [
  ...models,
  ...(kokoroModel?.revision
    ? KOKORO_VOICES.map((voice) => ({
        id: `kokoro-voice-${voice}`,
        engine: "kokoro",
        lang: "en" as const,
        modelId: kokoroModel.modelId,
        revision: kokoroModel.revision,
        license: kokoroModel.license,
        verified: true,
        files: [
          {
            url: `https://huggingface.co/${kokoroModel.modelId}/resolve/${kokoroModel.revision}/voices/${voice}.bin`,
            sha256: kokoroVoices[voice]?.sha256 ?? "",
            bytes: kokoroVoices[voice]?.bytes ?? 0,
          },
        ],
      }))
    : []),
];

export const MODEL_CATALOG = models.map((model) => ({
  ...model,
  bytes: model.files.reduce((total, file) => total + file.bytes, 0),
}));
