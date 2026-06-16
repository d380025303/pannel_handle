import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildConfig, createHookConfigManager, getProjectPath } = require("./hook-config-manager.cjs");

const assetsDir = path.join(import.meta.dirname, "hook-assets");
const tempDirs = [];

function createProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-hooks-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("hook-config-manager", () => {
  it("installs Claude, Codex, and OpenCode hooks into an empty Windows project", () => {
    const projectPath = createProject();
    const manager = createHookConfigManager({ assetsDir });

    const result = manager.install({ type: "windows", path: projectPath }, ["claude", "codex", "opencode"]);

    expect(result.ok).toBe(true);
    expect(result.providers.claude.status).toBe("installed");
    expect(result.providers.codex.status).toBe("installed");
    expect(result.providers.opencode.status).toBe("installed");
    expect(result.providers.opencode.configPath).toBeUndefined();
    expect(result.providers.opencode.managedHookCount).toBe(1);
    expect(fs.existsSync(path.join(projectPath, ".claude", "pannel-handle-hook.ps1"))).toBe(true);
    expect(fs.existsSync(path.join(projectPath, ".codex", "pannel-handle-hook.ps1"))).toBe(true);
    expect(fs.existsSync(path.join(projectPath, ".opencode", "plugins", "pannel-handle-notification.js"))).toBe(true);
  });

  it("reports and repairs a modified OpenCode plugin without creating opencode.json", () => {
    const projectPath = createProject();
    const pluginPath = path.join(projectPath, ".opencode", "plugins", "pannel-handle-notification.js");
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, "modified", "utf-8");
    const manager = createHookConfigManager({ assetsDir });

    expect(manager.inspect({ type: "windows", path: projectPath }, ["opencode"]).providers.opencode.status)
      .toBe("needs_repair");

    const result = manager.install({ type: "windows", path: projectPath }, ["opencode"]);

    expect(result.providers.opencode.status).toBe("installed");
    expect(fs.existsSync(`${pluginPath}.pannel-handle.bak`)).toBe(true);
    expect(fs.existsSync(path.join(projectPath, "opencode.json"))).toBe(false);
  });

  it("uses one platform-independent OpenCode plugin asset", () => {
    const projectPath = createProject();
    const manager = createHookConfigManager({ assetsDir });

    const result = manager.install({ type: "windows", path: projectPath }, ["opencode"]);
    const pluginPath = path.join(projectPath, ".opencode", "plugins", "pannel-handle-notification.js");

    expect(result.providers.opencode.status).toBe("installed");
    expect(fs.readFileSync(pluginPath, "utf-8")).toBe(
      fs.readFileSync(path.join(assetsDir, "pannel-handle-opencode-plugin.js"), "utf-8")
    );
  });

  it("preserves unrelated settings and replaces duplicate managed hooks", () => {
    const projectPath = createProject();
    const configPath = path.join(projectPath, ".claude", "settings.local.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      permissions: { allow: ["Bash(git status)"] },
      mcpServers: { example: { command: "example" } },
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "other-hook" }] },
          { hooks: [{ type: "command", command: "powershell -File old/pannel-handle-hook.ps1" }] },
          { hooks: [{ type: "command", command: "bash old/pannel-handle-hook.sh" }] }
        ]
      }
    }), "utf-8");
    const manager = createHookConfigManager({ assetsDir });

    const result = manager.install({ type: "windows", path: projectPath }, ["claude"]);
    const saved = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const commands = Object.values(saved.hooks)
      .flat()
      .flatMap(group => group.hooks || [])
      .map(hook => hook.command);

    expect(result.providers.claude.status).toBe("installed");
    expect(saved.permissions.allow).toEqual(["Bash(git status)"]);
    expect(saved.mcpServers.example.command).toBe("example");
    expect(commands.filter(command => command === "other-hook")).toHaveLength(1);
    expect(commands.filter(command => command.includes("pannel-handle-hook.ps1"))).toHaveLength(9);
    expect(fs.existsSync(`${configPath}.pannel-handle.bak`)).toBe(true);
  });

  it("does not write any provider when an existing config contains invalid JSON", () => {
    const projectPath = createProject();
    const invalidPath = path.join(projectPath, ".codex", "hooks.json");
    fs.mkdirSync(path.dirname(invalidPath), { recursive: true });
    fs.writeFileSync(invalidPath, "{ invalid", "utf-8");
    const manager = createHookConfigManager({ assetsDir });

    const result = manager.install({ type: "windows", path: projectPath }, ["claude", "codex"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid JSON");
    expect(fs.existsSync(path.join(projectPath, ".claude", "settings.local.json"))).toBe(false);
    expect(fs.readFileSync(invalidPath, "utf-8")).toBe("{ invalid");
  });

  it("rolls back earlier writes when a later write fails", () => {
    const projectPath = createProject();
    const failingFs = new Proxy(fs, {
      get(target, property) {
        if (property === "writeFileSync") {
          return (filePath, ...args) => {
            if (String(filePath).includes(".codex") && String(filePath).endsWith(".pannel-handle.tmp")) {
              throw new Error("directory is read-only");
            }
            return target.writeFileSync(filePath, ...args);
          };
        }
        return target[property];
      }
    });
    const manager = createHookConfigManager({ assetsDir, fsApi: failingFs });

    const result = manager.install({ type: "windows", path: projectPath }, ["claude", "codex"]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("read-only");
    expect(fs.existsSync(path.join(projectPath, ".claude", "settings.local.json"))).toBe(false);
    expect(fs.existsSync(path.join(projectPath, ".claude", "pannel-handle-hook.ps1"))).toBe(false);
  });

  it("rolls back OpenCode when a later provider write fails", () => {
    const projectPath = createProject();
    const failingFs = new Proxy(fs, {
      get(target, property) {
        if (property === "writeFileSync") {
          return (filePath, ...args) => {
            if (String(filePath).includes(".codex") && String(filePath).endsWith(".pannel-handle.tmp")) {
              throw new Error("directory is read-only");
            }
            return target.writeFileSync(filePath, ...args);
          };
        }
        return target[property];
      }
    });
    const manager = createHookConfigManager({ assetsDir, fsApi: failingFs });

    const result = manager.install({ type: "windows", path: projectPath }, ["opencode", "codex"]);

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(projectPath, ".opencode", "plugins", "pannel-handle-notification.js"))).toBe(false);
  });

  it("builds the WSL UNC project path and generates Bash commands", () => {
    expect(getProjectPath({ type: "wsl", path: "/home/me/project", wslDistro: "Ubuntu-24.04" }))
      .toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\project");

    const config = buildConfig({}, "claude", "wsl");
    expect(config.hooks.Stop[0].hooks[0].command).toBe("bash .claude/pannel-handle-hook.sh");
  });

  it("builds SSH Linux hook config with a session tunnel command", () => {
    const config = buildConfig({}, "codex", "ssh", "PANNEL_HANDLE_HOOK_URL='http://127.0.0.1:3000/claude-hook' PANNEL_HANDLE_SESSION_ID='run-1' bash .codex/pannel-handle-hook.sh");

    expect(config.hooks.SessionStart[0].hooks[0].command).toContain("PANNEL_HANDLE_SESSION_ID='run-1'");
    expect(config.hooks.Stop[0].hooks[0].command).toContain(".codex/pannel-handle-hook.sh");
  });

  it("reports missing project paths without creating files", () => {
    const projectPath = path.join(createProject(), "missing");
    const manager = createHookConfigManager({ assetsDir });

    const result = manager.install({ type: "windows", path: projectPath }, ["claude"]);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(fs.existsSync(projectPath)).toBe(false);
  });
});
