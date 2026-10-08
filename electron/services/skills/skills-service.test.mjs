import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSkillsService } from "./skills-service.cjs";

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
