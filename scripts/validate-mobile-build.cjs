const fs = require("node:fs");
const path = require("node:path");

const mobileDist = path.resolve(__dirname, "..", "mobile", "dist");
const manifestPath = path.join(mobileDist, "build-manifest.json");
const indexPath = path.join(mobileDist, "index.html");

if (!fs.existsSync(manifestPath) || !fs.existsSync(indexPath)) {
  console.error("Mobile build is missing. Run `corepack pnpm build:mobile` from the repository root first.");
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`Unable to read mobile build manifest: ${error.message || error}`);
  process.exit(1);
}

if (manifest.application !== "pannel-handle-mobile" || manifest.protocolVersion !== 1) {
  console.error("Mobile build manifest is incompatible with desktop remote protocol v1.");
  process.exit(1);
}

console.log(`Mobile build ready: protocol v${manifest.protocolVersion}, built ${manifest.builtAt || "unknown"}`);
