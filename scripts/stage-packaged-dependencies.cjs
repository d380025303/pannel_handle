const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.join(__dirname, "..");
const stagingRoot = path.join(projectRoot, ".cache", "packaged-dependencies");

function resolvePackage(name, from) {
  let directory = fs.realpathSync(from);
  while (true) {
    const candidate = path.join(directory, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot resolve ${name} from ${from}`);
    directory = parent;
  }
}

function copyPackage(source, target, mappings, ancestors = new Set()) {
  const realSource = fs.realpathSync(source);
  if (ancestors.has(realSource)) throw new Error(`Circular dependency while staging ${source}`);
  const staged = path.join(stagingRoot, String(mappings.length));
  fs.cpSync(realSource, staged, {
    recursive: true,
    dereference: true,
    filter: file => path.relative(realSource, file).split(path.sep)[0] !== "node_modules",
  });
  mappings.push({ from: staged, to: target, filter: ["**/*"] });
  const metadata = JSON.parse(fs.readFileSync(path.join(realSource, "package.json"), "utf8"));
  const nextAncestors = new Set([...ancestors, realSource]);
  for (const name of Object.keys(metadata.dependencies || {})) {
    copyPackage(resolvePackage(name, realSource), `${target}/node_modules/${name}`, mappings, nextAncestors);
  }
}

module.exports = async context => {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  const mappings = [];
  // Preserve versions that electron-builder's pnpm collector otherwise hoists incorrectly.
  for (const [parent, dependency] of [["jszip", "readable-stream"], ["type-is", "content-type"]]) {
    const store = path.join(projectRoot, "node_modules", ".pnpm");
    const entry = fs.readdirSync(store).find(name => name.startsWith(`${parent}@${parent === "type-is" ? "2." : "3."}`));
    if (!entry) throw new Error(`Cannot find installed ${parent} for packaging`);
    const parentDirectory = path.join(store, entry, "node_modules", parent);
    copyPackage(resolvePackage(dependency, parentDirectory), `node_modules/${parent}/node_modules/${dependency}`, mappings);
  }
  context.packager.config.files.push(...mappings);
};
