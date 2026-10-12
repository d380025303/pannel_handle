import { afterEach, expect, test } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const script = fileURLToPath(new URL("./verify-packaged-dependencies.cjs", import.meta.url));
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function verify(manifests, fallback = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "packaged-dependencies-"));
  temporaryDirectories.push(directory);
  const source = path.join(directory, "source");
  const output = path.join(directory, "app");
  const resources = path.join(output, "resources");
  function write(root, files) {
    for (const [file, manifest] of Object.entries(files)) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(manifest));
    }
  }
  write(source, manifests);
  fs.mkdirSync(resources, { recursive: true });
  await asar.createPackage(source, path.join(resources, "app.asar"));
  write(path.join(resources, "node_modules"), fallback);
  return spawnSync(process.execPath, [script, output], { encoding: "utf8" });
}

for (const location of ["archive", "fallback"]) {
  for (const version of ["3.25.0", "4.4.3"]) {
    test(`${location} zod@${version} is checked against ^4.4.3`, async () => {
      const manifest = { name: "zod", version };
      const result = await verify({
        "package.json": { dependencies: { zod: "^4.4.3" } },
        ...(location === "archive" ? { "node_modules/zod/package.json": manifest } : {}),
      }, location === "fallback" ? { "zod/package.json": manifest } : {});
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(version === "4.4.3" ? 0 : 1);
      if (version === "3.25.0") {
        expect(result.stderr).toContain("/package.json: zod requires ^4.4.3, actual 3.25.0");
        expect(result.stdout).not.toContain("graph is complete");
      } else {
        expect(result.stdout).toContain("graph is complete");
      }
    });
  }
}

test("an incompatible nested archive dependency cannot be hidden by compatible outer packages", async () => {
  const result = await verify({
    "package.json": { dependencies: { parent: "1.0.0" } },
    "node_modules/parent/package.json": { version: "1.0.0", dependencies: { zod: "^4.4.3" } },
    "node_modules/parent/node_modules/zod/package.json": { version: "3.25.0" },
    "node_modules/zod/package.json": { version: "4.4.3" },
  }, { "zod/package.json": { version: "4.4.3" } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("/node_modules/parent/package.json: zod requires ^4.4.3, actual 3.25.0");
});

test("fallback transitive dependencies are checked outside the archive", async () => {
  const result = await verify({
    "package.json": { dependencies: { parent: "1.0.0" } },
    "node_modules/zod/package.json": { version: "4.4.3" },
  }, {
    "parent/package.json": { version: "1.0.0", dependencies: { zod: "^4.4.3" } },
    "zod/package.json": { version: "3.25.0" },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("/node_modules/__fallback__/parent/package.json: zod requires ^4.4.3, actual 3.25.0");
});

for (const version of ["3.25.0", "4.4.3", null]) {
  test(`fallback parent resolves ${version ? `nested zod@${version}` : "top-level zod"} first`, async () => {
    const result = await verify({
      "package.json": { dependencies: { parent: "1.0.0" } },
    }, {
      "parent/package.json": { version: "1.0.0", dependencies: { zod: "^4.4.3" } },
      "zod/package.json": { version: "4.4.3" },
      ...(version ? { "parent/node_modules/zod/package.json": { version } } : {}),
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(version === "3.25.0" ? 1 : 0);
    if (version === "3.25.0") {
      expect(result.stderr).toContain("/node_modules/__fallback__/parent/package.json: zod requires ^4.4.3, actual 3.25.0");
      expect(result.stdout).not.toContain("graph is complete");
    } else {
      expect(result.stdout).toContain("graph is complete");
    }
  });
}

test("resolved nested fallback packages recursively check dependencies in ancestor packages", async () => {
  const result = await verify({
    "package.json": { dependencies: { "@fixture/parent": "1.0.0" } },
  }, {
    "@fixture/parent/package.json": { version: "1.0.0", dependencies: { child: "1.0.0" } },
    "@fixture/parent/node_modules/child/package.json": { version: "1.0.0", dependencies: { zod: "^4.4.3" } },
    "@fixture/parent/node_modules/zod/package.json": { version: "3.25.0" },
    "zod/package.json": { version: "4.4.3" },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("/node_modules/__fallback__/@fixture/parent/node_modules/child/package.json: zod requires ^4.4.3, actual 3.25.0");
});
