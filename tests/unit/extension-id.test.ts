import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "../../wxt.config";

describe("extension ID", () => {
  it("matches the ID the server installer allows to use its native host", () => {
    const manifest = config.manifest as { key: string };
    const digest = createHash("sha256")
      .update(Buffer.from(manifest.key, "base64"))
      .digest("hex")
      .slice(0, 32);
    const id = [...digest]
      .map((char) => String.fromCharCode(97 + Number.parseInt(char, 16)))
      .join("");

    const installer = readFileSync("server/native_host_manifest.py", "utf8");
    expect(installer).toContain(`DEV_EXTENSION_ID = "${id}"`);
  });
});
