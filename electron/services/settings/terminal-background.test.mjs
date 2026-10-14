import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createConfigStore } = require("../../stores/config-store.cjs");
const {
  TERMINAL_BG_SCHEME,
  isValidBackgroundName,
  registerTerminalBackgroundScheme,
  registerTerminalBackgroundProtocol,
  copyBackgroundImage
} = require("./terminal-background.cjs");

const tempDirs = [];

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-terminal-bg-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("isValidBackgroundName", () => {
  it.each(["123-bg.png", "a.b_c-d.webp", "背景 图.jpg"])("accepts basename %s", (name) => {
    expect(isValidBackgroundName(name)).toBe(true);
  });

  it.each(["", "../x.png", "a/b.png", "a\\b.png", "..", null, undefined, 42])("rejects %s", (name) => {
    expect(isValidBackgroundName(name)).toBe(false);
  });

  it("rejects overly long names", () => {
    expect(isValidBackgroundName("a".repeat(261))).toBe(false);
  });
});

describe("registerTerminalBackgroundScheme", () => {
  it("registers the scheme as privileged", () => {
    const protocolApi = { registerSchemesAsPrivileged: vi.fn() };
    registerTerminalBackgroundScheme(protocolApi);
    expect(protocolApi.registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: TERMINAL_BG_SCHEME,
      privileges: expect.objectContaining({ standard: true, secure: true })
    }]);
  });
});

describe("registerTerminalBackgroundProtocol", () => {
  function createProtocolHarness(userDataDir) {
    const handlers = new Map();
    const protocolApi = {
      registerFileProtocol: vi.fn((scheme, handler) => handlers.set(scheme, handler))
    };
    registerTerminalBackgroundProtocol(protocolApi, userDataDir);
    return handlers.get(TERMINAL_BG_SCHEME);
  }

  it("serves an existing image from the userData background directory", () => {
    const userDataDir = createTempDir();
    const bgDir = path.join(userDataDir, "terminal-background");
    fs.mkdirSync(bgDir, { recursive: true });
    fs.writeFileSync(path.join(bgDir, "123-bg.png"), "png-bytes");
    const handler = createProtocolHarness(userDataDir);
    const callback = vi.fn();

    handler({ url: "terminal-bg://background/123-bg.png" }, callback);

    expect(callback).toHaveBeenCalledWith({ path: path.join(bgDir, "123-bg.png") });
  });

  it("rejects path traversal and unknown files", () => {
    const userDataDir = createTempDir();
    const handler = createProtocolHarness(userDataDir);
    const callback = vi.fn();

    handler({ url: "terminal-bg://background/..%2Fsecret.png" }, callback);
    handler({ url: "terminal-bg://background/missing.png" }, callback);
    handler({ url: "terminal-bg://other/123-bg.png" }, callback);

    expect(callback).toHaveBeenCalledTimes(3);
    for (const call of callback.mock.calls) {
      expect(call[0]).toEqual({ error: -6 });
    }
  });
});

describe("copyBackgroundImage", () => {
  it.each([
    ["photo..png", "photo_"],
    ["photo...png", "photo_"],
    ["photo..summer.png", "photo_summer"],
    ["photo.summer.png", "photo.summer"],
    [`${"a".repeat(79)}.x.png`, `${"a".repeat(79)}_`]
  ])("keeps imported %s configured and accessible after reload", (filename, safeBase) => {
    const userDataDir = createTempDir();
    const sourceFile = path.join(createTempDir(), filename);
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
    fs.writeFileSync(sourceFile, imageBytes);
    const configFile = path.join(userDataDir, "config.json");
    const store = createConfigStore({ configFile });
    store.updateConfig({ terminalBackgroundImage: "existing.png" }, { throwOnSaveError: true });

    const name = copyBackgroundImage(sourceFile, userDataDir);
    expect(name.slice(name.indexOf("-") + 1)).toMatch(new RegExp(`^${safeBase.replaceAll(".", "\\.")}-[0-9a-f-]+\\.png$`));
    expect(isValidBackgroundName(name)).toBe(true);
    store.updateConfig({ terminalBackgroundImage: name }, { throwOnSaveError: true });
    expect(store.getConfig().terminalBackgroundImage).toBe(name);

    const reloaded = createConfigStore({ configFile });
    reloaded.loadConfig();
    expect(reloaded.getConfig().terminalBackgroundImage).toBe(name);
    let handler;
    registerTerminalBackgroundProtocol({
      registerFileProtocol: (_scheme, callback) => { handler = callback; }
    }, userDataDir);
    const callback = vi.fn();
    handler({ url: `terminal-bg://background/${reloaded.getConfig().terminalBackgroundImage}` }, callback);
    const imagePath = path.join(userDataDir, "terminal-background", name);
    expect(callback).toHaveBeenCalledWith({ path: imagePath });
    expect(fs.readFileSync(imagePath)).toEqual(imageBytes);
  });

  it("copies an allowed image into the background directory with a unique name", () => {
    const userDataDir = createTempDir();
    const sourceDir = createTempDir();
    const sourceFile = path.join(sourceDir, "My Photo.PNG");
    fs.writeFileSync(sourceFile, "image-bytes");

    const name = copyBackgroundImage(sourceFile, userDataDir);

    expect(name).toMatch(/^\d+-My_Photo-[0-9a-f-]+\.png$/);
    expect(fs.readFileSync(path.join(userDataDir, "terminal-background", name), "utf-8")).toBe("image-bytes");
  });

  it("rejects unsupported extensions and oversized files", () => {
    const userDataDir = createTempDir();
    const sourceDir = createTempDir();
    const textFile = path.join(sourceDir, "notes.txt");
    fs.writeFileSync(textFile, "hello");
    expect(() => copyBackgroundImage(textFile, userDataDir)).toThrow(/Unsupported image type/);

    const bigFile = path.join(sourceDir, "big.png");
    fs.writeFileSync(bigFile, Buffer.alloc(20 * 1024 * 1024 + 1));
    expect(() => copyBackgroundImage(bigFile, userDataDir)).toThrow(/too large/);

    expect(() => copyBackgroundImage("", userDataDir)).toThrow(/Invalid source path/);
  });
});


it("uses distinct filenames even for imports in the same millisecond", () => {
  const dir = createTempDir();
  const source = path.join(createTempDir(), "image.png");
  fs.writeFileSync(source, "image");
  const clock = vi.spyOn(Date, "now").mockReturnValue(123);
  try {
    expect(copyBackgroundImage(source, dir)).not.toBe(copyBackgroundImage(source, dir));
    expect(fs.readdirSync(path.join(dir, "terminal-background"))).toHaveLength(2);
  } finally {
    clock.mockRestore();
  }
});

it("limits deletion to image basenames within the managed directory", async () => {
  const { removeBackgroundImage } = require("./terminal-background.cjs");
  const dir = createTempDir();
  const outside = path.join(dir, "keep.png");
  fs.writeFileSync(outside, "keep");
  for (const name of ["../keep.png", outside, "a:b.png", "..", "config.json"]) {
    await removeBackgroundImage(name, dir);
  }
  expect(fs.readFileSync(outside, "utf8")).toBe("keep");
  await removeBackgroundImage("missing.png", dir);
});
