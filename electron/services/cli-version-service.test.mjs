import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCliVersionService } = require("./cli-version-service.cjs");

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  let version = "2.0.0";
  const installed = () => ({ currentVersion: version, commandPath: "/bin/cli", method: "npm" });
  const installation = deferred();
  const started = deferred();
  const probe = vi.fn(async () => installed());
  const install = vi.fn(async (_target, onOutput) => {
    onOutput("npm install output");
    started.resolve();
    await installation.promise;
    version = "2.1.0";
  });
  const service = createCliVersionService({
    target: id => ({ key: id === "remote" ? "ssh:remote" : "windows" }),
    probe, latestVersion: async () => "2.1.0", install,
    messages: { updating: "already updating", checkFirst: "check first" },
  });
  return { service, probe, install, installation, started, installed };
}

describe("shared CLI version state machine", () => {
  it("locks updates across sessions sharing an environment and keeps other environments independent", async () => {
    const h = harness();
    await h.service.check("one");
    const pending = h.service.update("one");
    await h.started.promise;
    await expect(h.service.update("two")).rejects.toThrow("already updating");
    expect(await h.service.check("two", true)).toMatchObject({ status: "updating", environment: "windows" });
    expect(await h.service.check("remote")).toMatchObject({ status: "available", environment: "ssh:remote" });
    expect(h.install).toHaveBeenCalledTimes(1);
    h.installation.resolve();
    expect(await pending).toMatchObject({ status: "current", restartRequired: true });
  });

  it.each(["success", "failure"])("isolates a stale %s check during and after an update", async outcome => {
    const h = harness();
    await h.service.check("one");
    const staleDuring = deferred();
    const staleAfter = deferred();
    h.probe.mockImplementationOnce(() => staleDuring.promise);
    const during = h.service.check("one", true);
    h.probe.mockImplementationOnce(() => staleAfter.promise);
    const after = h.service.check("two", true);
    const pending = h.service.update("one");
    await h.started.promise;
    const settle = stale => outcome === "success" ? stale.resolve(h.installed()) : stale.reject(new Error("stale probe failure"));
    settle(staleDuring);
    expect(await during).toMatchObject({ status: "updating", progress: { stage: "installing" } });
    h.installation.resolve();
    const completed = await pending;
    settle(staleAfter);
    expect(await after).toEqual(completed);
    expect(await h.service.check("two")).toEqual(completed);
  });

  it("retains failed progress for other sessions and releases the update lock", async () => {
    const h = harness();
    await h.service.check("one");
    const pending = h.service.update("one");
    const rejected = expect(pending).rejects.toThrow("install failed");
    await h.started.promise;
    h.installation.reject(new Error("install failed"));
    await rejected;
    expect(await h.service.check("two")).toMatchObject({ status: "error", error: "install failed",
      progress: { stage: "failed", output: "npm install output" } });
    await expect(h.service.update("two")).rejects.toThrow("check first");
  });
});
