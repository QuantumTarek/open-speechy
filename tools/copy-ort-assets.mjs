import { copyFile, mkdir, access } from "node:fs/promises";
import { resolve } from "node:path";

const sourceDirectory = resolve(
  process.cwd(),
  "node_modules/onnxruntime-web/dist",
);
const targetDirectory = resolve(process.cwd(), "public/ort");
const runtimeFiles = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
];

await mkdir(targetDirectory, { recursive: true });
for (const filename of runtimeFiles) {
  const source = resolve(sourceDirectory, filename);
  const target = resolve(targetDirectory, filename);
  await access(source);
  await copyFile(source, target);
  console.log(`Copied ${filename}`);
}
