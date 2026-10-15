import { createRequire } from "node:module";
import { describe, it, expect, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createInjectedTools } = require("./injected-tools.cjs");
const config = { tools: [{ name: "lookup", description: "Lookup", inputSchema: { type: "object" } }],
  toolCallback: { url: "http://localhost/tools", bearerToken: "private-token", timeoutMs: 1000 } };
const params = { threadId: "thread", turnId: "turn", callId: "call", tool: "lookup", arguments: { id: "1" } };
function fixture(fetchRequest = vi.fn(async () => new Response(JSON.stringify({ success: true, output: "done" })))) {
  const respond = vi.fn();
  const current = vi.fn(() => true);
  return { respond, current, fetchRequest, tools: createInjectedTools({ config, sessionId: "run", current, respond, fetchRequest }) };
}
describe("injected tool callbacks", () => {
  it("revokes execution authorization even if a thread still advertises the tool", async () => {
    const f = fixture(); f.tools.revoke(); await f.tools.call(1, params);
    expect(f.tools.definitions).toEqual([]); expect(f.fetchRequest).not.toHaveBeenCalled();
    expect(f.respond.mock.calls[0][1].success).toBe(false);
  });
  it("sends the isolated payload and converts text results", async () => {
    const f = fixture(); await f.tools.call(1, params);
    const [url, options] = f.fetchRequest.mock.calls[0];
    expect(url).toBe(config.toolCallback.url);
    expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer private-token" } });
    expect(JSON.parse(options.body)).toEqual({ sessionId: "run", ...params });
    expect(f.tools.definitions[0]).toMatchObject({ type: "function", name: "lookup" });
    expect(f.respond).toHaveBeenCalledWith(1, { success: true, contentItems: [{ type: "inputText", text: "done" }] });
    expect(JSON.stringify(f.tools.definitions)).not.toContain("private-token");
  });
  it.each([new Response('bad'), new Response('{}'), new Response('no', { status: 503 }),
    new Response(JSON.stringify({ success: true, output: "x".repeat(262144) }))])("returns failure for invalid responses", async response => {
    const f = fixture(vi.fn(async () => response)); await f.tools.call(1, params);
    expect(f.respond.mock.calls[0][1].success).toBe(false);
  });
  it("reports HTTP callback errors without exposing the bearer token", async () => {
    const f = fixture(vi.fn(async () => new Response(JSON.stringify({ error: { code: "tool_callback_failed", message: "负责人工具授权已失效。 private-token" } }), { status: 401 })));
    await f.tools.call(1, params);
    const output = f.respond.mock.calls[0][1].contentItems[0].text;
    expect(output).toContain("HTTP 401"); expect(output).toContain("负责人工具授权已失效");
    expect(output).not.toContain("private-token");
  });
  it.each([
    [async () => { throw new Error("private-token"); }, "网络请求失败"],
    [async () => new Response("bad json"), "响应格式无效"],
    [async () => new Response("bad gateway private-token", { status: 502 }), "HTTP 502"]
  ])("distinguishes transport failures without exposing raw payloads", async (fetchRequest, message) => {
    const f = fixture(vi.fn(fetchRequest)); await f.tools.call(1, params);
    expect(f.respond.mock.calls[0][1].contentItems[0].text).toContain(message);
    expect(JSON.stringify(f.respond.mock.calls)).not.toContain("private-token");
  });
  it("cancels the old turn but allows a new turn with the same tool permissions", async () => {
    let resolve;
    const f = fixture(vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ success: true, output: "continued" }))));
    const first = f.tools.call(1, params); f.tools.cancel();
    resolve(new Response(JSON.stringify({ success: true, output: "late" }))); await first;
    expect(f.respond).not.toHaveBeenCalled();
    await f.tools.call(2, { ...params, turnId: "next-turn" });
    expect(f.respond).toHaveBeenCalledWith(2, expect.objectContaining({ success: true }));
  });
  it("returns business errors without treating them as transport failures", async () => {
    const f = fixture(vi.fn(async () => new Response(JSON.stringify({ success: false, output: "missing order" }))));
    await f.tools.call(1, params); expect(f.respond.mock.calls[0][1]).toMatchObject({ success: false, contentItems: [{ text: "missing order" }] });
  });
  it("rejects stale, unknown and duplicate calls before fetching", async () => {
    const f = fixture(); f.current.mockReturnValueOnce(false);
    await f.tools.call(1, params); await f.tools.call(2, { ...params, tool: "unknown" });
    await f.tools.call(3, params); await f.tools.call(4, params);
    expect(f.fetchRequest).toHaveBeenCalledTimes(1);
  });
  it("runs independent calls concurrently and discards cancelled late responses", async () => {
    const resolves = [];
    const f = fixture(vi.fn(() => new Promise(resolve => resolves.push(resolve))));
    const first = f.tools.call(1, params); const second = f.tools.call(2, { ...params, callId: "other" });
    expect(f.fetchRequest).toHaveBeenCalledTimes(2);
    expect(f.tools.ownsRequest(params)).toBe(true);
    expect(f.tools.ownsRequest({ ...params, callId: "unknown" })).toBe(false);
    f.tools.cancel();
    expect(f.tools.ownsRequest(params)).toBe(false);
    for (const resolve of resolves) resolve(new Response(JSON.stringify({ success: true, output: "late" })));
    await Promise.all([first, second]); expect(f.respond).not.toHaveBeenCalled();
    expect(f.fetchRequest.mock.calls.every(([, options]) => options.signal.aborted)).toBe(true);
  });
  it("times out without retrying or leaking errors", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(vi.fn((url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("private-token"))))));
      const call = f.tools.call(1, params); await vi.advanceTimersByTimeAsync(1000); await call;
      expect(f.fetchRequest).toHaveBeenCalledTimes(1);
      expect(f.respond.mock.calls[0][1]).toMatchObject({ success: false });
      expect(JSON.stringify(f.respond.mock.calls)).not.toContain("private-token");
    } finally { vi.useRealTimers(); }
  });
});
