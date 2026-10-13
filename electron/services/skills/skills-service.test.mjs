import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSkillsService } from "./skills-service.cjs";

const require = createRequire(import.meta.url);
const SftpClient = require("ssh2-sftp-client");
const { createSshFileSystem } = require("../../ssh/ssh-file-system.cjs");

it.each([
  [32 * 1024 * 1024, 32 * 1024 * 1024, false],
  [1024, 32 * 1024 * 1024, false],
  [0, 0, true],
  [1024, 1024, true],
  [2 * 1024 * 1024, 2 * 1024 * 1024, true]
])("bounds SSH Skill reads (stat %i, actual %i)", async (reportedSize, actualSize, succeeds) => {
  const limit = 2 * 1024 * 1024;
  let transferred = 0;
  let source;
  const sftp = new SftpClient();
  // Use the installed client's real stat/createReadStream methods with a simulated remote channel.
  sftp.sftp = {
    stat: vi.fn((_path, callback) => callback(null, {
      size: reportedSize, mode: 0o100644, uid: 0, gid: 0, atime: 0, mtime: 0,
      isDirectory: () => false, isFile: () => true, isBlockDevice: () => false,
      isCharacterDevice: () => false, isSymbolicLink: () => false, isFIFO: () => false, isSocket: () => false
    })),
    createReadStream: vi.fn((_path, options) => {
      source = new Readable({ highWaterMark: options.highWaterMark, read(size) {
        const remaining = Math.min(actualSize, options.end + 1) - transferred;
        if (remaining <= 0) { this.push(null); return; }
        const length = Math.min(size, remaining);
        transferred += length;
        this.push(Buffer.alloc(length, 120));
      } });
      return source;
    })
  };
  const sshFileSystem = createSshFileSystem({ sshSessionRuntime: { createSftpClient: async () => sftp } });
  const session = { id: "ssh-1", type: "ssh", runtimeMode: "app-server", agentProvider: "codex", cwd: "/repo" };
  const service = createSkillsService({ homeDir: createHome(), sshFileSystem,
    terminalManager: { getSession: () => session },
    codexAppServerSessionService: { listSkills: async () => [{ name: "remote", path: "/repo/SKILL.md" }] }
  });
  const { skills: [skill] } = await service.list("codex", session.id);
  if (succeeds) {
    expect((await service.read("codex", skill.id, session.id)).content).toBe("x".repeat(actualSize));
    expect(transferred).toBe(actualSize);
  } else {
    await expect(service.read("codex", skill.id, session.id)).rejects.toThrow("Skill 文件超过 2 MB");
  }
  expect(sftp.sftp.stat).toHaveBeenCalledTimes(1);
  if (reportedSize > limit) {
    expect(sftp.sftp.createReadStream).not.toHaveBeenCalled();
    expect(transferred).toBe(0);
  } else {
    expect(sftp.sftp.createReadStream).toHaveBeenCalledWith(skill.path, { end: limit, highWaterMark: 64 * 1024 });
    expect(transferred).toBeLessThanOrEqual(limit + 1);
    expect(source.destroyed).toBe(true);
  }
});

const tempDirs = [];

function createHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-skills-"));
  tempDirs.push(home);
  return home;
}

function writeSkill(home, relativeDirectory, content) {
  const directory = path.join(home, relativeDirectory);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), content);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("skills-service", () => {
  it("lists Codex personal and built-in skills with their sources", async () => {
    const home = createHome();
    writeSkill(home, ".codex/skills/review", "---\nname: review\ndescription: Review code\n---\nDo it.");
    writeSkill(home, ".agents/skills/review", "---\nname: review\ndescription: Another review\n---\nDo it.");
    writeSkill(home, ".codex/skills/.system/imagegen", "---\nname: imagegen\ndescription: Generate images\n---\nSystem.");

    const catalog = await createSkillsService({ homeDir: home }).list("codex");

    expect(catalog).toMatchObject({ pluginStatus: "requires-session", projectStatus: "no-session" });
    expect(catalog.skills).toEqual([
      expect.objectContaining({ name: "imagegen", description: "Generate images", source: "system" }),
      expect.objectContaining({ name: "review", description: "Another review", source: "personal" }),
      expect.objectContaining({ name: "review", description: "Review code", source: "personal" })
    ]);
    expect(new Set(catalog.skills.map(skill => skill.id)).size).toBe(3);
  });

  it("reads UTF-8 BOM front matter without exposing document content", async () => {
    const home = createHome();
    writeSkill(home, ".codex/skills/review", Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("---\r\nname: review\r\ndescription: Review code\r\n---\r\nPrivate instructions", "utf-8")
    ]));

    const { skills: [skill] } = await createSkillsService({ homeDir: home }).list("codex");

    expect(skill).toMatchObject({ id: expect.any(String), name: "review", description: "Review code",
      source: "personal", enabled: true });
    expect(Object.hasOwn(skill, "content")).toBe(false);
  });

  it("returns an empty CodeBuddy list without creating its directory", async () => {
    const home = createHome();

    await expect(createSkillsService({ homeDir: home }).list("codebuddy")).resolves.toMatchObject({ skills: [] });
    expect(fs.existsSync(path.join(home, ".codebuddy", "skills"))).toBe(false);
  });

  it("keeps malformed skills visible with the directory name and an empty description", async () => {
    const home = createHome();
    writeSkill(home, ".codebuddy/skills/plain", "Instructions without front matter.");

    const { skills: [skill] } = await createSkillsService({ homeDir: home }).list("codebuddy");

    expect(skill).toMatchObject({ id: expect.any(String), name: "plain", description: "", source: "personal" });
  });

  it.each(["\n", "\r\n"])("parses front matter with %j line endings and delimiter whitespace", async (newline) => {
    const home = createHome();
    writeSkill(home, ".codebuddy/skills/review", [
      "--- \t", "", "name: 'Review'", 'description: "Review code"', "---", "Instructions."
    ].join(newline));

    const { skills: [skill] } = await createSkillsService({ homeDir: home }).list("codebuddy");

    expect(skill).toMatchObject({ name: "Review", description: "Review code" });
  });

  it.each([64000, 128000])("handles %i blank lines without a closing delimiter promptly", async (blankLines) => {
    const home = path.resolve("skills-performance-home");
    const content = Buffer.from("---\n" + "\n".repeat(blankLines) + "body");
    const fsApi = { promises: {
      readdir: async () => [{ name: "malformed", isDirectory: () => true }],
      realpath: async directory => directory,
      stat: async () => ({ isFile: () => true, size: content.length }),
      readFile: async () => content
    } };
    const service = createSkillsService({ homeDir: home, fsApi });
    const started = performance.now();
    const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - started), 0));

    const { skills: [skill] } = await service.list("codebuddy");
    const elapsed = await timer;

    expect(skill).toMatchObject({ name: "malformed", description: "", source: "personal" });
    // A generous event-loop budget catches the multi-second backtracking regression.
    expect(elapsed).toBeLessThan(1000);
  });

  it("rejects unsupported providers", async () => {
    const home = createHome();
    await expect(createSkillsService({ homeDir: home }).list("other")).rejects.toThrow("Unsupported Skills provider");
  });

  it("follows symlinked skill folders without reading outside SKILL.md content", async () => {
    const home = createHome();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-skills-outside-"));
    tempDirs.push(outside);
    writeSkill(outside, "escaped", "---\nname: escaped\ndescription: Outside\n---\nNo.");
    const root = path.join(home, ".codex", "skills");
    fs.mkdirSync(root, { recursive: true });
    try {
      fs.symlinkSync(path.join(outside, "escaped"), path.join(root, "escaped"), "junction");
    } catch (err) {
      if (process.platform === "win32" && err.code === "EPERM") return;
      throw err;
    }

    const catalog = await createSkillsService({ homeDir: home }).list("codex");
    expect(catalog.skills).toEqual([expect.objectContaining({ name: "escaped", source: "personal" })]);
    expect(Object.hasOwn(catalog.skills[0], "content")).toBe(false);
  });

  it("finds project skills from the working directory through the repository root", async () => {
    const home = createHome();
    const repository = path.join(home, "repo");
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repository, "module", "feature"), { recursive: true });
    writeSkill(home, "repo/.agents/skills/shared", "---\nname: duplicate\ndescription: Root\n---");
    writeSkill(home, "repo/module/.agents/skills/module", "---\nname: duplicate\ndescription: Module\n---");
    writeSkill(home, "repo/module/feature/.agents/skills/local", "---\nname: local\ndescription: Local\n---");
    const session = { id: "run-1", type: "windows", cwd: path.join(repository, "module", "feature") };
    const service = createSkillsService({ homeDir: home, terminalManager: { getSession: () => session } });

    const catalog = await service.list("codex", session.id);
    expect(catalog.projectStatus).toBe("available");
    expect(catalog.skills.map(skill => [skill.name, skill.source])).toEqual([
      ["duplicate", "project"], ["duplicate", "project"], ["local", "project"]
    ]);
  });

  it("does not classify personal skills as project skills outside a Git repository", async () => {
    const home = createHome();
    writeSkill(home, ".agents/skills/personal", "---\nname: personal\n---");
    fs.mkdirSync(path.join(home, "work"), { recursive: true });
    const session = { id: "run-1", type: "windows", cwd: path.join(home, "work") };
    const service = createSkillsService({ homeDir: home, terminalManager: { getSession: () => session } });
    const catalog = await service.list("codex", session.id);
    expect(catalog.skills).toEqual([expect.objectContaining({ name: "personal", source: "personal" })]);
  });

  it("uses the active Codex runtime list and keeps remote, plugin, and disabled skills distinct", async () => {
    const home = createHome();
    const session = { id: "ssh-1", type: "ssh", cwd: "/work/repo", runtimeMode: "app-server", agentProvider: "codex" };
    const listSkills = async () => [
      { name: "same", path: "/work/repo/.agents/skills/same/SKILL.md", description: "Project", scope: "repo", enabled: true },
      { name: "same", path: "/home/me/.agents/skills/same/SKILL.md", description: "Personal", scope: "user", enabled: true },
      { name: "figma", path: "/home/me/.codex/plugins/cache/figma/skills/figma/SKILL.md", description: "Plugin", scope: "user", enabled: false },
      { name: "creator", path: "/home/me/.codex/skills/.system/creator/SKILL.md", description: "Built-in", scope: "system", enabled: true }
    ];
    const service = createSkillsService({ homeDir: home, terminalManager: { getSession: () => session },
      codexAppServerSessionService: { getWorkspaceCwd: () => "/work/repo", listSkills } });
    const catalog = await service.list("codex", session.id);
    expect(catalog).toMatchObject({ pluginStatus: "available", projectStatus: "available", projectPath: "/work/repo" });
    expect(catalog.skills.map(skill => [skill.name, skill.source, skill.enabled])).toEqual([
      ["creator", "system", true], ["figma", "plugin", false],
      ["same", "personal", true], ["same", "project", true]
    ]);
  });

  it("does not replace remote skills with Windows skills when no Codex runtime is available", async () => {
    const home = createHome();
    writeSkill(home, ".agents/skills/local", "---\nname: local\n---");
    const session = { id: "ssh-1", type: "ssh", cwd: "/work/repo" };
    const service = createSkillsService({ homeDir: home, terminalManager: { getSession: () => session } });
    await expect(service.list("codex", session.id)).resolves.toMatchObject({
      skills: [], pluginStatus: "requires-session", projectStatus: "remote-unavailable"
    });
  });
});

it("reads only catalogued Skills and returns the full source", async () => {
  const home = createHome();
  const content = "---\nname: review\n---\n# Instructions\nFull details";
  writeSkill(home, ".agents/skills/review", content);
  const service = createSkillsService({ homeDir: home });
  const { skills } = await service.list("codex");
  expect(await service.read("codex", skills[0].id)).toMatchObject({ name: "review", content });
  await expect(service.read("codex", "../secret")).rejects.toThrow(/Skill/);
  fs.unlinkSync(skills[0].path);
  await expect(service.read("codex", skills[0].id)).rejects.toThrow(/Skill/);
});

it.each(["codex", "codebuddy"])("reads one 128 KiB document after listing 100 real %s Skills", async provider => {
  const home = createHome();
  const content = "x".repeat(128 * 1024);
  for (let index = 0; index < 100; index++) writeSkill(home, `.${provider}/skills/skill-${index}`, content);
  let reads = 0;
  let bytes = 0;
  const fsApi = { promises: { ...fs.promises, readFile: async (...args) => {
    const buffer = await fs.promises.readFile(...args);
    reads++;
    bytes += buffer.length;
    return buffer;
  } } };
  const service = createSkillsService({ homeDir: home, fsApi });
  const { skills } = await service.list(provider);
  expect(reads).toBe(100);
  reads = bytes = 0;
  expect((await service.read(provider, skills[0].id)).content).toBe(content);
  expect({ reads, bytes }).toEqual({ reads: 1, bytes: 128 * 1024 });
  reads = bytes = 0;
  await service.read(provider, skills[0].id);
  expect({ reads, bytes }).toEqual({ reads: 1, bytes: 128 * 1024 });
});

it.each(["codex", "codebuddy"])("skips oversized %s Skills before reading on every refresh", async provider => {
  const home = createHome();
  const root = `.${provider}/skills`;
  const content = "---\nname: normal\n---\nInstructions";
  writeSkill(home, `${root}/normal`, content);
  const boundary = "x".repeat(2 * 1024 * 1024);
  writeSkill(home, `${root}/boundary`, boundary);
  const oversizedPaths = new Map([
    [path.join(writeSkill(home, `${root}/over-limit`, "unused"), "SKILL.md"), 2 * 1024 * 1024 + 1],
    [path.join(writeSkill(home, `${root}/huge`, "unused"), "SKILL.md"), 32 * 1024 * 1024]
  ]);
  const reads = [];
  let bytes = 0;
  const fsApi = { promises: { ...fs.promises,
    stat: async filePath => {
      const stat = await fs.promises.stat(filePath);
      if (oversizedPaths.has(filePath)) stat.size = oversizedPaths.get(filePath);
      return stat;
    },
    readFile: async filePath => {
      reads.push(filePath);
      const buffer = oversizedPaths.has(filePath)
        ? Buffer.alloc(oversizedPaths.get(filePath)) : await fs.promises.readFile(filePath);
      bytes += buffer.length;
      return buffer;
    }
  } };
  const service = createSkillsService({ homeDir: home, fsApi });
  for (let refresh = 0; refresh < 2; refresh++) {
    reads.length = 0;
    bytes = 0;
    const { skills } = await service.list(provider);
    expect(skills.map(skill => skill.name)).toEqual(["boundary", "normal"]);
    expect(reads).toHaveLength(2);
    expect(reads.some(filePath => oversizedPaths.has(filePath))).toBe(false);
    expect(bytes).toBe(Buffer.byteLength(content) + boundary.length);
    for (const skill of skills) {
      reads.length = 0;
      bytes = 0;
      const expected = skill.name === "normal" ? content : boundary;
      expect((await service.read(provider, skill.id)).content).toBe(expected);
      expect(reads).toEqual([skill.path]);
      expect(bytes).toBe(Buffer.byteLength(expected));
    }
  }
});

it("rediscovers cache misses and replaces metadata and membership on refresh", async () => {
  const home = createHome();
  writeSkill(home, ".codebuddy/skills/first", "old");
  const service = createSkillsService({ homeDir: home });
  const { skills: [first] } = await service.list("codebuddy");
  writeSkill(home, ".codebuddy/skills/first", "---\nname: updated\n---\nnew");
  await service.list("codebuddy");
  expect(await service.read("codebuddy", first.id)).toMatchObject({ name: "updated", content: expect.stringContaining("new") });
  writeSkill(home, ".codebuddy/skills/added", "added");
  const { skills } = await createSkillsService({ homeDir: home }).list("codebuddy");
  const added = skills.find(skill => skill.name === "added");
  expect((await service.read("codebuddy", added.id)).content).toBe("added");
  fs.unlinkSync(first.path);
  await service.list("codebuddy");
  await expect(service.read("codebuddy", first.id)).rejects.toThrow("Skill 已不存在");
  await expect(service.read("codex", added.id)).rejects.toThrow("Skill 已不存在");
});

it("isolates sessions, replaced sessions, working directories and CODEX_HOME", async () => {
  const home = createHome();
  writeSkill(home, "one/.agents/skills/one", "one");
  writeSkill(home, "two/.agents/skills/two", "two");
  let session = { id: "one", type: "windows", cwd: path.join(home, "one") };
  const other = { id: "two", type: "windows", cwd: path.join(home, "two") };
  let codexHome = path.join(home, "codex-one");
  const service = createSkillsService({ homeDir: home,
    terminalManager: { getSession: id => id === "one" ? session : other },
    environmentService: { resolve: () => ({ CODEX_HOME: codexHome }) } });
  const { skills: [first] } = await service.list("codex", "one");
  await expect(service.read("codex", first.id, "two")).rejects.toThrow("Skill 已不存在");
  session = { ...session, cwd: other.cwd };
  await expect(service.read("codex", first.id, "one")).rejects.toThrow("Skill 已不存在");
  session.cwd = path.join(home, "one");
  expect((await service.read("codex", first.id, "one")).content).toBe("one");
  writeSkill(home, "codex-one/skills/personal", "personal");
  const { skills } = await service.list("codex", "one");
  const personal = skills.find(skill => skill.name === "personal");
  codexHome = path.join(home, "codex-two");
  await expect(service.read("codex", personal.id, "one")).rejects.toThrow("Skill 已不存在");
  session = null;
  await expect(service.read("codex", first.id, "one")).rejects.toThrow("Skills session does not exist");
});

it("checks cached file size and rejects a session switch during a read", async () => {
  const home = createHome();
  writeSkill(home, ".codebuddy/skills/first", "first");
  let session = { id: "one", type: "windows", cwd: home };
  let switchDuringRead = false;
  const service = createSkillsService({ homeDir: home, terminalManager: { getSession: () => session },
    fsApi: { promises: { ...fs.promises, readFile: async (...args) => {
      const result = await fs.promises.readFile(...args);
      if (switchDuringRead) session = { ...session };
      return result;
    } } } });
  const { skills: [first] } = await service.list("codebuddy", "one");
  fs.writeFileSync(first.path, "x".repeat(2 * 1024 * 1024 + 1));
  await expect(service.read("codebuddy", first.id, "one")).rejects.toThrow("2 MB");
  fs.writeFileSync(first.path, "first");
  switchDuringRead = true;
  await expect(service.read("codebuddy", first.id, "one")).rejects.toThrow("会话已切换");
});
