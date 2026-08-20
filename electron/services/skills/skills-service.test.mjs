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
  it("lists Codex user and system skills as name and description summaries", async () => {
    const home = createHome();
    writeSkill(home, ".codex/skills/review", "---\nname: review\ndescription: Review code\n---\nDo it.");
    writeSkill(home, ".codex/skills/.system/imagegen", "---\nname: imagegen\ndescription: Generate images\n---\nSystem.");

    const skills = await createSkillsService({ homeDir: home }).list("codex");

    expect(skills).toEqual([
      { id: expect.any(String), name: "imagegen", description: "Generate images" },
      { id: expect.any(String), name: "review", description: "Review code" }
    ]);
  });

  it("reads UTF-8 BOM front matter without exposing document content", async () => {
    const home = createHome();
    writeSkill(home, ".codex/skills/review", Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("---\r\nname: review\r\ndescription: Review code\r\n---\r\nPrivate instructions", "utf-8")
    ]));

    const [skill] = await createSkillsService({ homeDir: home }).list("codex");

    expect(skill).toEqual({ id: expect.any(String), name: "review", description: "Review code" });
    expect(Object.hasOwn(skill, "content")).toBe(false);
  });

  it("returns an empty CodeBuddy list without creating its directory", async () => {
    const home = createHome();

    await expect(createSkillsService({ homeDir: home }).list("codebuddy")).resolves.toEqual([]);
    expect(fs.existsSync(path.join(home, ".codebuddy", "skills"))).toBe(false);
  });

  it("keeps malformed skills visible with the directory name and an empty description", async () => {
    const home = createHome();
    writeSkill(home, ".codebuddy/skills/plain", "Instructions without front matter.");

    const [skill] = await createSkillsService({ homeDir: home }).list("codebuddy");

    expect(skill).toEqual({ id: expect.any(String), name: "plain", description: "" });
  });

  it("rejects unsupported providers", async () => {
    const home = createHome();
    await expect(createSkillsService({ homeDir: home }).list("other")).rejects.toThrow("Unsupported Skills provider");
  });

  it("ignores skill symlinks that escape the configured root", async () => {
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

    await expect(createSkillsService({ homeDir: home }).list("codex")).resolves.toEqual([]);
  });
});
