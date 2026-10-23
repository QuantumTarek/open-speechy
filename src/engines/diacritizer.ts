import * as ort from "onnxruntime-web";
import type { ModelManager } from "../models/manager";
import { packagedUrl } from "./packaged-url";

const ARABIC_MARK = /[\u064b-\u065f\u0670]/u;
const ARABIC_BASE = /[\u0621-\u064a\u066e-\u06d3\u06fa-\u06fc]/u;
const DIACRITICS = new Set([
  "\u064b",
  "\u064c",
  "\u064d",
  "\u064e",
  "\u064f",
  "\u0650",
  "\u0651",
  "\u0652",
]);
const ARABIC_AND_LATIN_DIGITS = /[0-9\u0660-\u0669\u06f0-\u06f9]/u;
const DIACRITIC_ORDER = new Map([
  ["\u064e\u0651", "\u0651\u064e"],
  ["\u064f\u0651", "\u0651\u064f"],
  ["\u0650\u0651", "\u0651\u0650"],
  ["\u064b\u0651", "\u0651\u064b"],
  ["\u064c\u0651", "\u0651\u064c"],
  ["\u064d\u0651", "\u0651\u064d"],
]);

const DIACRITIZER_MODEL_ID = "arabic-libtashkeel-fp32";

export type DiacritizerPredictor = (text: string) => Promise<string>;

export function isMostlyDiacritized(text: string): boolean {
  let letters = 0;
  let markedLetters = 0;
  const chars = Array.from(text);
  for (let index = 0; index < chars.length; index += 1) {
    if (!ARABIC_BASE.test(chars[index])) continue;
    letters += 1;
    if (ARABIC_MARK.test(chars[index + 1] ?? "")) markedLetters += 1;
  }
  return letters > 0 && markedLetters / letters > 0.3;
}

export function preserveWordOffsets(
  originalWords: string[],
  predictedText: string,
): string[] {
  const predictedWords = predictedText.trim().split(/\s+/u).filter(Boolean);
  return predictedWords.length === originalWords.length
    ? predictedWords
    : originalWords;
}

export class ArabicDiacritizer {
  readonly #enabled: boolean;
  readonly #predictor?: DiacritizerPredictor;

  constructor(enabled = false, predictor?: DiacritizerPredictor) {
    this.#enabled = enabled;
    this.#predictor = predictor;
  }

  async apply(words: string[]): Promise<string[]> {
    if (
      !this.#enabled ||
      !this.#predictor ||
      isMostlyDiacritized(words.join(" "))
    ) {
      return words;
    }
    try {
      return preserveWordOffsets(
        words,
        await this.#predictor(words.join(" ")),
      );
    } catch {
      return words;
    }
  }
}

export interface LibTashkeelMaps {
  input: Record<string, number>;
  hint: Record<string, number>;
  target: Record<string, number>;
}

export interface PreparedTashkeelInput {
  inputIds: bigint[];
  hintIds: bigint[];
  cleanLength: number;
  removedCharacters: Set<string>;
}

export function prepareTashkeelInput(
  text: string,
  maps: LibTashkeelMaps,
): PreparedTashkeelInput {
  const valid: string[] = [];
  const removedCharacters = new Set<string>();
  for (const char of text.trimStart()) {
    if (DIACRITICS.has(char)) {
      valid.push(char);
    } else if (ARABIC_AND_LATIN_DIGITS.test(char)) {
      valid.push("#");
    } else if (Object.hasOwn(maps.input, char)) {
      valid.push(char);
    } else {
      removedCharacters.add(char);
    }
  }

  const clean: string[] = [];
  const hints: string[] = [];
  let pendingMarks = "";
  for (const char of [...valid, " "]) {
    if (DIACRITICS.has(char)) {
      pendingMarks += char;
    } else {
      clean.push(char);
      hints.push(pendingMarks);
      pendingMarks = "";
    }
  }
  clean.pop();
  hints.shift();

  const inputIds = clean.map((char) => maps.input[char] ?? maps.input._);
  const hintIds = hints.map((hint) => {
    const normalized = DIACRITIC_ORDER.get(hint) ?? hint;
    return maps.hint[normalized] ?? maps.hint[""];
  });
  return {
    inputIds: inputIds.map(BigInt),
    hintIds: hintIds.map(BigInt),
    cleanLength: clean.length,
    removedCharacters,
  };
}

export function restoreTashkeel(
  originalText: string,
  targetIds: ArrayLike<number>,
  maps: LibTashkeelMaps,
  removedCharacters: Set<string>,
): string {
  const targetById = new Map(
    Object.entries(maps.target).map(([mark, id]) => [id, mark]),
  );
  const paddingId = maps.input._;
  const predicted = Array.from(targetIds)
    .filter((id) => id !== paddingId)
    .map((id) => targetById.get(id));
  const targetCount = Array.from(originalText).filter(
    (char) => !DIACRITICS.has(char) && !removedCharacters.has(char),
  ).length;
  if (predicted.length !== targetCount || predicted.some((mark) => mark === undefined)) {
    return originalText;
  }

  let targetIndex = 0;
  let output = "";
  for (const char of originalText) {
    if (DIACRITICS.has(char)) continue;
    output += char;
    if (removedCharacters.has(char)) continue;
    output += predicted[targetIndex++] ?? "";
  }
  return output;
}

export function createLibTashkeelPredictor(
  models: ModelManager,
): DiacritizerPredictor {
  let loaded:
    | Promise<{
        session: ort.InferenceSession;
        maps: LibTashkeelMaps;
      }>
    | null = null;

  const load = async () => {
    const model = models.get(DIACRITIZER_MODEL_ID);
    if (!model || !models.canDownload(DIACRITIZER_MODEL_ID)) {
      throw new Error("The pinned Arabic diacritizer is not available.");
    }
    if (!(await models.isInstalled(DIACRITIZER_MODEL_ID))) {
      await models.download(DIACRITIZER_MODEL_ID);
    }
    const onnxFile = model.files.find((file) => file.url.endsWith(".onnx"));
    const mapsFile = model.files.find((file) => file.url.endsWith(".json"));
    if (!onnxFile || !mapsFile) {
      throw new Error("The Arabic diacritizer manifest is incomplete.");
    }

    const [onnxBytes, mapsBytes] = await Promise.all([
      models.readFile(DIACRITIZER_MODEL_ID, onnxFile.url),
      models.readFile(DIACRITIZER_MODEL_ID, mapsFile.url),
    ]);
    ort.env.wasm.wasmPaths = packagedUrl("ort/");
    const session = await ort.InferenceSession.create(onnxBytes, {
      executionProviders: ["wasm"],
    });
    const maps = JSON.parse(new TextDecoder().decode(mapsBytes)) as LibTashkeelMaps;
    return { session, maps };
  };

  return async (text) => {
    loaded ??= load();
    const { session, maps } = await loaded;
    const prepared = prepareTashkeelInput(text, maps);
    if (prepared.cleanLength === 0) return text;
    const outputs = await session.run({
      input_ids: new ort.Tensor(
        "int64",
        BigInt64Array.from(prepared.inputIds),
        [1, prepared.cleanLength],
      ),
      diac_ids: new ort.Tensor(
        "int64",
        BigInt64Array.from(prepared.hintIds),
        [1, prepared.cleanLength],
      ),
      input_length: new ort.Tensor(
        "int64",
        BigInt64Array.of(BigInt(prepared.cleanLength)),
        [1],
      ),
    });
    const targetIds = outputs.target_ids?.data;
    if (!targetIds || !ArrayBuffer.isView(targetIds)) return text;
    return restoreTashkeel(text, targetIds as ArrayLike<number>, maps, prepared.removedCharacters);
  };
}
