const asar = require("@electron/asar");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const pnpmStore = path.join(projectRoot, "node_modules", ".pnpm");
const semver = require(require.resolve("semver", {
  paths: [path.dirname(require.resolve("app-builder-lib/package.json", {
    paths: [path.dirname(require.resolve("electron-builder/package.json"))]
  }))]
}));

function installedPackage(name, versionRange) {
  const direct = path.join(projectRoot, "node_modules", name);
  if (fs.existsSync(path.join(direct, "package.json"))
    && semver.satisfies(JSON.parse(fs.readFileSync(path.join(direct, "package.json"), "utf8")).version, versionRange)) return direct;
  const prefix = `${name.replace("/", "+")}@`;
  for (const entry of fs.readdirSync(pnpmStore)) {
    if (!entry.startsWith(prefix)) continue;
    const candidate = path.join(pnpmStore, entry, "node_modules", name);
    const manifest = path.join(candidate, "package.json");
    if (fs.existsSync(manifest) && semver.satisfies(JSON.parse(fs.readFileSync(manifest, "utf8")).version, versionRange)) return candidate;
  }
  return null;
}

function inspect(appOutDir, repair) {
  const resources = path.join(appOutDir, "resources");
  const archive = path.join(resources, "app.asar");
  const fallbackRoot = path.join(resources, "node_modules");
  const files = new Set(asar.listPackage(archive).map(file => file.replaceAll("\\", "/")));
  const queue = ["/package.json", ...[...files].filter(file => file.endsWith("/package.json") && file.includes("/node_modules/")
    && !file.includes("/benchmark/") && !file.startsWith("/node_modules/nan/tools/"))];
  if (fs.existsSync(fallbackRoot)) {
    for (const entry of fs.readdirSync(fallbackRoot)) {
      const names = entry.startsWith("@")
        ? fs.readdirSync(path.join(fallbackRoot, entry)).map(name => `${entry}/${name}`)
        : [entry];
      for (const name of names) {
        if (fs.existsSync(path.join(fallbackRoot, name, "package.json"))) {
          queue.push(`/node_modules/__fallback__/${name}/package.json`);
        }
      }
    }
  }
  const seen = new Set();
  const missing = [];
  const copied = new Set();

  function packagedPackage(from, name) {
    // Modules outside app.asar cannot resolve dependencies inside the archive.
    if (from.startsWith("/node_modules/__fallback__/")) {
      return fs.existsSync(path.join(fallbackRoot, name, "package.json"));
    }
    let directory = path.posix.dirname(from);
    while (true) {
      const candidate = `${directory}/node_modules/${name}/package.json`.replace(/^\/\//, "/");
      if (files.has(candidate)) return true;
      if (directory === "/") break;
      directory = path.posix.dirname(directory);
    }
    return fs.existsSync(path.join(fallbackRoot, name, "package.json"));
  }

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const metadata = file.startsWith("/node_modules/__fallback__/")
      ? JSON.parse(fs.readFileSync(path.join(fallbackRoot, file.slice("/node_modules/__fallback__/".length)), "utf8"))
      : JSON.parse(asar.extractFile(archive, file.slice(1).replaceAll("/", "\\")).toString());
    for (const [name, versionRange] of Object.entries(metadata.dependencies || {})) {
      if (packagedPackage(file, name)) continue;
      const source = installedPackage(name, versionRange);
      if (!repair || !source) {
        missing.push(`${file}: ${name}`);
        continue;
      }
      fs.cpSync(source, path.join(fallbackRoot, name), { recursive: true, dereference: true });
      copied.add(name);
      queue.push(`/node_modules/__fallback__/${name}/package.json`);
    }
  }
  if (missing.length) throw new Error(`Missing packaged dependencies (${missing.length}):\n${missing.join("\n")}`);
  console.log(`Packaged dependency graph is complete${copied.size ? `; copied ${copied.size} omitted modules` : ""}.`);
}

module.exports = async context => {
  inspect(context.appOutDir, true);
  require("./smoke-packaged-dependencies.cjs")(context.appOutDir);
};

if (require.main === module) {
  try {
    inspect(process.argv[2] || path.join(projectRoot, "release", "win-unpacked"), false);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
