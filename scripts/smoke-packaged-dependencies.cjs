const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function smoke(appOutDir) {
  const executable = path.resolve(appOutDir, "Pannel Handle.exe");
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-packaged-smoke-"));
  try {
    // Keep the resource tree outside the repository so development dependencies
    // cannot hide modules omitted from the portable package.
    fs.cpSync(path.join(appOutDir, "resources"), path.join(isolatedRoot, "resources"), { recursive: true });
    const modulePaths = [
      "mobile-remote/mobile-files.cjs",
      "mcp/session-status-server.cjs"
    ].map(relative => path.join(isolatedRoot, "resources", "app.asar", "electron", "services", relative));
    const marker = path.join(isolatedRoot, "loaded.txt");
    const script = `${modulePaths.map(modulePath => `require(${JSON.stringify(modulePath)});`).join(" ")} require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok");`;
    const result = spawnSync(executable, ["-e", script], {
      cwd: isolatedRoot,
      env: { ...process.env, NODE_PATH: "", ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 15000
    });
    if (result.error || result.status !== 0 || !fs.existsSync(marker)) {
      throw new Error(`Packaged services failed to load: ${result.error?.message || result.stderr || result.status}`);
    }
    console.log("Packaged mobile-files and session-status-server loaded successfully.");
  } finally {
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

module.exports = smoke;
if (require.main === module) {
  smoke(process.argv[2] || path.join(__dirname, "..", "release", "win-unpacked"));
}
