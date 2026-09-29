const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const appOutDir = path.join(__dirname, "..", "release", "win-unpacked");
const executable = path.join(__dirname, "..", "node_modules", "electron", "dist", "electron.exe");
const modulePath = path.join(appOutDir, "resources", "app.asar", "electron", "services", "mobile-remote", "mobile-files.cjs");
const marker = path.join(os.tmpdir(), `pannel-packaged-smoke-${process.pid}.txt`);
const script = `require(${JSON.stringify(modulePath)}); require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok");`;
const result = spawnSync(executable, ["-e", script], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 15000
});
try {
  if (result.error || result.status !== 0 || !fs.existsSync(marker)) {
    throw new Error(`Packaged mobile-files failed to load: ${result.error?.message || result.stderr || result.status}`);
  }
  console.log("Packaged mobile-files loaded successfully.");
} finally {
  fs.rmSync(marker, { force: true });
}
