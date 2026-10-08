import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseOpenCodeAdditionalDirectories, type OpenCodeDirectoryEnvironment } from "./openCodeAdditionalDirectories";

const { normalizeAdditionalDirectories } = createRequire(import.meta.url)("../../electron/services/opencode-acp/additional-directories.cjs");
const environments: Array<[OpenCodeDirectoryEnvironment, string, string]> = [
  [{ type: "windows", cwd: "C:\\work" }, "C:\\共享 目录", "/work/shared"],
  [{ type: "wsl", cwd: "/work" }, "/work/共享 目录", "C:\\shared"],
  [{ type: "ssh", agentLocation: "remote", cwd: "/work" }, "/srv/shared", "C:\\shared"],
  [{ type: "ssh", agentLocation: "remote", cwd: "C:\\work", sshConfig: { remotePlatform: "windows" } }, "\\\\server\\share\\shared", "/shared"],
  [{ type: "ssh", agentLocation: "local", cwd: "/srv/work" }, "C:\\shared", "/srv/shared"]
];

describe("OpenCode additional directory validation", () => {
  it.each(environments)("uses the Agent path rules in %j", (environment, valid, invalid) => {
    expect(parseOpenCodeAdditionalDirectories(`  ${valid}  \n\n`, environment)).toEqual([valid]);
    expect(normalizeAdditionalDirectories([` ${valid} `, ""], environment)).toEqual([valid]);
    expect(parseOpenCodeAdditionalDirectories(invalid, environment)).toBeNull();
    expect(() => normalizeAdditionalDirectories([invalid], environment)).toThrow("绝对路径");
  });
  it.each(["relative", "~", "$HOME/shared", "C:shared", "\\shared", "C:\\shared*", "C:\\shared?", "C:\\a\0b", "\\\\server"])("rejects %j", directory => {
    expect(parseOpenCodeAdditionalDirectories(directory, environments[0][0])).toBeNull();
    expect(() => normalizeAdditionalDirectories([directory], environments[0][0])).toThrow();
  });
  it("rejects malformed IPC arrays and line breaks within a path", () => {
    for (const value of [null, "C:\\shared", [5], ["C:\\a\nb"], ["C:\\a\rb"]])
      expect(() => normalizeAdditionalDirectories(value, environments[0][0])).toThrow();
  });
  it("deduplicates Windows paths case-insensitively and POSIX paths case-sensitively", () => {
    expect(normalizeAdditionalDirectories(["C:\\Shared", "c:/shared/", "C:\\x\\..\\Shared", "\\\\server\\share", "\\\\SERVER\\share\\"], environments[0][0]))
      .toEqual(["C:\\Shared", "\\\\server\\share"]);
    expect(normalizeAdditionalDirectories(["/Shared", "/shared", "/shared/", "/x/../shared"], environments[1][0])).toEqual(["/Shared", "/shared"]);
    expect(parseOpenCodeAdditionalDirectories("", environments[0][0])).toEqual([]);
    expect(normalizeAdditionalDirectories(undefined, environments[0][0])).toEqual([]);
  });
  it("honors the runtime local bridge instead of the remote directory", () => {
    expect(normalizeAdditionalDirectories(["C:\\shared"], { type: "ssh", cwd: "/srv/work" }, { localBridge: true })).toEqual(["C:\\shared"]);
  });
});
