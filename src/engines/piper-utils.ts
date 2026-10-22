export interface PiperInferenceConfig {
  noise_scale: number;
  length_scale: number;
  noise_w: number;
}

export function parsePiperPhonemeOutput(output: string[]): number[] {
  for (const line of output) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "phoneme_ids" in parsed &&
        Array.isArray(parsed.phoneme_ids) &&
        parsed.phoneme_ids.every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        )
      ) {
        return parsed.phoneme_ids;
      }
    } catch {
      // The WASM module may emit non-JSON status lines before its result.
    }
  }
  throw new Error("Piper phonemization returned no phoneme IDs.");
}

export function piperScales(
  inference: PiperInferenceConfig,
  speed: number,
): Float32Array {
  return new Float32Array([
    inference.noise_scale,
    inference.length_scale / speed,
    inference.noise_w,
  ]);
}
