import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { buildSsh2ConnectionConfig, validateSsh2Config } = require("./ssh2-connection.cjs");
const { createKnownHostStore } = require("../stores/known-host-store.cjs");

const tempDirs = [];

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-ssh2-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ssh2 connection config", () => {
  it("builds password auth config and rejects unsupported extra args", () => {
    const config = buildSsh2ConnectionConfig({
      sshConfig: {
        host: "example.com",
        username: "deploy",
        port: 2222
      },
      secret: "plain-secret"
    });

    expect(config).toMatchObject({
      host: "example.com",
      username: "deploy",
      port: 2222,
      password: "plain-secret",
      tryKeyboard: true,
      readyTimeout: 15000
    });
    expect(() => validateSsh2Config({
      host: "example.com",
      extraArgs: ["-o", "ServerAliveInterval=30"]
    })).toThrow("SSH extra arguments are not supported by the ssh2 backend.");
  });

  it("builds private key auth config with passphrase", () => {
    const dir = createTempDir();
    const keyPath = path.join(dir, "id_ed25519");
    fs.writeFileSync(keyPath, "private-key", "utf-8");

    const config = buildSsh2ConnectionConfig({
      sshConfig: {
        host: "example.com",
        identityFile: keyPath
      },
      secret: "key-passphrase"
    });

    expect(config.privateKey.toString("utf-8")).toBe("private-key");
    expect(config.passphrase).toBe("key-passphrase");
    expect(config.password).toBeUndefined();
  });

  it("saves first host fingerprint and rejects later mismatches", () => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    const knownHostStore = createKnownHostStore({
      knownHostsFile: path.join(createTempDir(), "known-hosts.json")
    });
    knownHostStore.loadKnownHosts();
    const seen = [];
    const firstConfig = buildSsh2ConnectionConfig({
      sshConfig: { host: "example.com", port: 22 },
      knownHostStore,
      onHostVerification: (result) => seen.push(result)
    });

    expect(firstConfig.hostVerifier(Buffer.from("host-key-a"))).toBe(true);
    expect(seen[0]).toMatchObject({
      accepted: true,
      trustedFirstUse: true
    });

    const secondConfig = buildSsh2ConnectionConfig({
      sshConfig: { host: "example.com", port: 22 },
      knownHostStore
    });

    expect(secondConfig.hostVerifier(Buffer.from("host-key-a"))).toBe(true);
    expect(secondConfig.hostVerifier(Buffer.from("host-key-b"))).toBe(false);
  });
});
