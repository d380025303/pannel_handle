const fs = require("fs");
const path = require("path");

const electronBuilderPackage = require.resolve("electron-builder/package.json");
const pnpmRoot = path.resolve(
  path.dirname(electronBuilderPackage),
  "..",
  "..",
  ".."
);
const appBuilderLibEntry = fs
  .readdirSync(pnpmRoot)
  .find((name) => name.startsWith("app-builder-lib@"));

if (!appBuilderLibEntry) {
  throw new Error(`Cannot find app-builder-lib in ${pnpmRoot}`);
}

const packageRoot = path.join(
  pnpmRoot,
  appBuilderLibEntry,
  "node_modules",
  "app-builder-lib"
);
const winPackagerPath = path.join(packageRoot, "out", "winPackager.js");
const source = fs.readFileSync(winPackagerPath, "utf8");

const patchedBlock = `if (process.platform === "win32" && this.info.framework.name === "electron") {
            const vendor = await (0, windows_1.getRceditBundle)((_c = this.config.toolsets) === null || _c === void 0 ? void 0 : _c.winCodeSign);
            await (0, builder_util_1.exec)(arch === builder_util_1.Arch.ia32 ? vendor.x86 : vendor.x64, args);
        }
        else if (process.platform === "win32" || process.platform === "darwin") {`;

if (source.includes(patchedBlock)) {
  process.exit(0);
}

const originalBlock = `if (process.platform === "win32" || process.platform === "darwin") {`;

if (!source.includes(originalBlock)) {
  throw new Error(`Cannot find electron-builder rcedit branch in ${winPackagerPath}`);
}

fs.writeFileSync(winPackagerPath, source.replace(originalBlock, patchedBlock));
