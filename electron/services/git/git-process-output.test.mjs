import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const { createGitService } = createRequire(import.meta.url)("./git-service.cjs");
const limit = 4 * 1024 * 1024;
const target = { sessionId: "output", cwd: "C:\\work\\repo" };

function serviceFor(result, onData) {
  return createGitService({
    terminalManager: { getSession: () => ({ id: "output", type: "windows", cwd: target.cwd }) },
    sessionStore: {},
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        const start = performance.now();
        for (const stream of ["stdout", "stderr"]) {
          for (const chunk of result[stream] || []) child[stream].emit("data", chunk);
        }
        onData?.(performance.now() - start);
        child.emit("close", result.code ?? 0);
      });
      return child;
    }
  });
}

describe("Git process output collection", () => {
  it("collects 4096 small chunks without scanning historical output", async () => {
    const chunks = Array.from({ length: 4096 }, () => Buffer.alloc(1024, 0));
    const byteLength = vi.spyOn(Buffer, "byteLength");
    try {
      await expect(serviceFor({ stdout: chunks }).getStatus(target)).resolves.toMatchObject({ clean: true });
      expect(byteLength).not.toHaveBeenCalled();
    } finally {
      byteLength.mockRestore();
    }
  });

  it.each(["stdout", "stderr"])("preserves the %s limit and overflow flag", async (stream) => {
    const full = Buffer.alloc(limit, 0);
    await expect(serviceFor({ [stream]: [full] }).getStatus(target)).resolves.toMatchObject({ clean: true });
    await expect(serviceFor({ [stream]: [full, Buffer.from("x")] }).getStatus(target))
      .rejects.toThrow("Git status output is too large");
  });

  it("decodes UTF-8 split across both streams on failure", async () => {
    const text = "中文😀";
    const chunks = Array.from(Buffer.from(text), (byte) => Buffer.from([byte]));
    await expect(serviceFor({ stdout: chunks, stderr: chunks, code: 1 }).getStatus(target))
      .rejects.toMatchObject({ stdout: text, stderr: text });
  });

  it("caps retained error output including a partial UTF-8 character", async () => {
    const chunks = [Buffer.alloc(limit - 1, 97), Buffer.from("中文")];
    await expect(serviceFor({ stdout: chunks, stderr: chunks, code: 1 }).getStatus(target))
      .rejects.toMatchObject({ stdout: "a".repeat(limit - 1) + "�", stderr: "a".repeat(limit - 1) + "�" });
  });

  it("keeps stdout and stderr budgets separate", async () => {
    await expect(serviceFor({ stdout: [Buffer.alloc(limit, 0)], stderr: [Buffer.alloc(limit, 0)] }).getStatus(target))
      .resolves.toMatchObject({ clean: true });
  });

  it("measures only data callbacks for 4 MiB at different chunk sizes", async () => {
    for (const size of [65536, 4096, 1024]) {
      const chunks = Array.from({ length: limit / size }, () => Buffer.alloc(size, 0));
      await serviceFor({ stdout: chunks }, (ms) => console.info(`${size} byte chunks: ${ms.toFixed(3)} ms`)).getStatus(target);
    }
  });
});
