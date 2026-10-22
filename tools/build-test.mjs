import { spawnSync } from "node:child_process";

const result = spawnSync("wxt", ["build", "--mode", "test"], {
  env: {
    ...process.env,
    VITE_OPEN_SPEECHY_FAKE_ENGINE: "1",
  },
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
