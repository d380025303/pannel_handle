import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("lists Codex user and system skills with the correct editability", async () => {
    const home = createHome();
    writeSkill(home, ".codex/skills/review", "---\nname: review\ndescription: Review code\n---\nDo it.");
    writeSkill(home, ".codex/skills/.system/imagegen", "---\nname: imagegen\ndescription: Generate images\n---\nSystem.");

    const skills = await createSkillsService({ homeDir: home }).list("codex");

    expect(skills).toEqual([
      expect.objectContaining({ name: "imagegen", source: "system", editable: false }),
      expect.objectContaining({ name: "review", source: "user", editable: true })
    ]);
    expect(skills.every((skill) => !Object.hasOwn(skill, "filePath"))).toBe(true);
  });

  it("adds provider-scoped usage counts using both Skill name and directory aliases", async () => {
    const home = createHome();
    writeSkill(home, ".codex/skills/review-dir", "---\nname: review\ndescription: Review code\n---\nDo it.");
    const statsStore = { getSkillUsage: (provider) => provider === "codex" ? [
      { name: "review", count: 2 },
      { name: "REVIEW-DIR", count: 3 }
    ] : [] };

    const service = createSkillsService({ homeDir: home, statsStore });
    const [skill] = await service.list("codex");

    expect(skill.usageCount).toBe(5);
    await expect(service.read(skill.id)).resolves.toEqual(expect.objectContaining({ usageCount: 5 }));
  });

  it("returns an empty CodeBuddy list when its directory does not exist", async () => {
    const home = createHome();
    await expect(createSkillsService({ homeDir: home }).list("codebuddy")).resolves.toEqual([]);
    expect(fs.existsSync(path.join(home, ".codebuddy", "skills"))).toBe(false);
  });

  it("keeps malformed skills visible with a metadata warning", async () => {
    const home = createHome();
    writeSkill(home, ".codebuddy/skills/plain", "Instructions without front matter.");

    const [skill] = await createSkillsService({ homeDir: home }).list("codebuddy");

    expect(skill).toEqual(expect.objectContaining({
      name: "plain",
      directoryName: "plain",
      warning: expect.stringContaining("front matter")
    }));
  });

  it("reads and saves UTF-8 content while preserving BOM and CRLF", async () => {
    const home = createHome();
    const directory = writeSkill(home, ".codex/skills/review", Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("---\r\nname: review\r\ndescription: Review code\r\n---\r\nOld", "utf-8")
    ]));
    const service = createSkillsService({ homeDir: home });
    const [summary] = await service.list("codex");
    const document = await service.read(summary.id);

    expect(document).toEqual(expect.objectContaining({ description: "Review code", bom: true, eol: "crlf", editable: true }));
    const saved = await service.save(summary.id, document.content.replace("Old", "New\nLine"), document.version);

    expect(saved.status).toBe("saved");
    const buffer = fs.readFileSync(path.join(directory, "SKILL.md"));
    expect(buffer.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(buffer.subarray(3).toString("utf-8")).toContain("New\r\nLine");
  });

  it("detects external changes and never overwrites them", async () => {
    const home = createHome();
    const directory = writeSkill(home, ".codebuddy/skills/review", "---\nname: review\ndescription: Review code\n---\nOld");
    const service = createSkillsService({ homeDir: home });
    const [summary] = await service.list("codebuddy");
    const document = await service.read(summary.id);
    fs.writeFileSync(path.join(directory, "SKILL.md"), "External change");

    await expect(service.save(summary.id, "Local change", document.version)).resolves.toEqual({ status: "conflict" });
    expect(fs.readFileSync(path.join(directory, "SKILL.md"), "utf-8")).toBe("External change");
  });

  it("rejects writes to Codex system skills", async () => {
    const home = createHome();
    writeSkill(home, ".codex/skills/.system/imagegen", "---\nname: imagegen\ndescription: Generate images\n---\nSystem.");
    const service = createSkillsService({ homeDir: home });
    const [summary] = await service.list("codex");
    const document = await service.read(summary.id);

    await expect(service.save(summary.id, "Changed", document.version)).rejects.toThrow("read-only");
  });

  it("moves an entire user Skill directory to the Recycle Bin", async () => {
    const home = createHome();
    const directory = writeSkill(home, ".codex/skills/review", "---\nname: review\ndescription: Review code\n---\nDo it.");
    fs.mkdirSync(path.join(directory, "scripts"));
    fs.writeFileSync(path.join(directory, "scripts", "review.mjs"), "export default true;");
    const trashItem = vi.fn(async (target) => fs.promises.rm(target, { recursive: true }));
    const service = createSkillsService({ homeDir: home, shellApi: { trashItem } });
    const summary = (await service.list("codex")).find((skill) => skill.source === "user");

    await expect(service.delete(summary.id)).resolves.toEqual({ status: "trashed" });

    expect(trashItem).toHaveBeenCalledWith(directory);
    expect(fs.existsSync(directory)).toBe(false);
    await expect(service.list("codex")).resolves.toEqual([]);
  });

  it("rejects deletion of Codex system Skills", async () => {
    const home = createHome();
    const directory = writeSkill(home, ".codex/skills/.system/imagegen", "---\nname: imagegen\ndescription: Generate images\n---\nSystem.");
    const trashItem = vi.fn();
    const service = createSkillsService({ homeDir: home, shellApi: { trashItem } });
    const [summary] = await service.list("codex");

    await expect(service.delete(summary.id)).rejects.toThrow("read-only");
    expect(trashItem).not.toHaveBeenCalled();
    expect(fs.existsSync(directory)).toBe(true);
  });

  it("rejects deletion when a listed Skill entry has been replaced", async () => {
    const home = createHome();
    const directory = writeSkill(home, ".codebuddy/skills/review", "---\nname: review\ndescription: Review code\n---\nOld.");
    const replacement = writeSkill(home, ".codebuddy/skills/replacement", "---\nname: replacement\ndescription: Replacement\n---\nNew.");
    const trashItem = vi.fn();
    const service = createSkillsService({ homeDir: home, shellApi: { trashItem } });
    const summary = (await service.list("codebuddy")).find((skill) => skill.directoryName === "review");
    fs.rmSync(directory, { recursive: true });
    try {
      fs.symlinkSync(replacement, directory, "junction");
    } catch (err) {
      if (process.platform === "win32" && err.code === "EPERM") return;
      throw err;
    }

    await expect(service.delete(summary.id)).rejects.toThrow("changed");
    expect(trashItem).not.toHaveBeenCalled();
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
