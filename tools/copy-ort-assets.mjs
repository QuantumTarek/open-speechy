import { copyFile, mkdir, access, realpath } from "node:fs/promises";
import { resolve } from "node:path";

// Piper and the diacritizer use the top-level onnxruntime-web. Kokoro runs on
// the onnxruntime-web build pinned by @huggingface/transformers. Both ship files
// with the same names, so each gets its own directory.
const transformersDirectory = await realpath(
  resolve(process.cwd(), "node_modules/@huggingface/transformers"),
);
const runtimes = [
  {
    sourceDirectory: resolve(process.cwd(), "node_modules/onnxruntime-web/dist"),
    targetDirectory: resolve(process.cwd(), "public/ort"),
    files: [
      "ort-wasm-simd-threaded.jsep.mjs",
      "ort-wasm-simd-threaded.jsep.wasm",
    ],
  },
  {
    sourceDirectory: resolve(transformersDirectory, "../../onnxruntime-web/dist"),
    targetDirectory: resolve(process.cwd(), "public/ort-transformers"),
    files: [
      "ort-wasm-simd-threaded.jsep.mjs",
      "ort-wasm-simd-threaded.jsep.wasm",
    ],
  },
];

for (const { sourceDirectory, targetDirectory, files } of runtimes) {
  await mkdir(targetDirectory, { recursive: true });
  for (const filename of files) {
    const source = resolve(sourceDirectory, filename);
    const target = resolve(targetDirectory, filename);
    await access(source);
    await copyFile(source, target);
    console.log(`Copied ${filename} to ${targetDirectory}`);
  }
}
