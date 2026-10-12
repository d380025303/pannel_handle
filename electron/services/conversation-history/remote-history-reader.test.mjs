import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import remoteModule from "./remote-history-reader.cjs";
import limits from "./history-limits.cjs";

afterEach(() => vi.useRealTimers());

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  const spawn = vi.fn(() => child);
  const exec = vi.fn(async () => JSON.stringify({ items: [], nextCursor: null }));
  const fsApi = { readFileSync: vi.fn(() => Buffer.from("print('test')")) };
  const read = remoteModule.createRemoteHistoryReader({ fsApi, remoteScriptFile: "fixture.py", spawn, sshAgentTransport: { exec } });
  return { child, spawn, exec, read, fsApi };
}

const unicodeResponse = { messages: [{ text: "中文回复😀🚀" }] };
const unicodeBytes = Buffer.from(JSON.stringify(unicodeResponse), "utf8");

it.each(Array.from({ length: unicodeBytes.length - 1 }, (_, index) => index + 1))(
  "preserves Chinese and emoji when WSL stdout is split at byte %i",
  async split => {
    const f = fixture();
    const result = f.read({ type: "wsl", wslDistro: "Ubuntu" }, "messages", {});
    f.child.stdout.emit("data", unicodeBytes.subarray(0, split));
    f.child.stdout.emit("data", unicodeBytes.subarray(split));
    f.child.emit("close", 0);
    await expect(result).resolves.toEqual(unicodeResponse);
    expect(f.child.kill).not.toHaveBeenCalled();
  }
);

it("preserves Unicode when every stdout chunk contains just one byte", async () => {
  const f = fixture();
  const result = f.read({ type: "wsl", wslDistro: "Ubuntu" }, "messages", {});
  for (const byte of unicodeBytes) f.child.stdout.emit("data", Buffer.from([byte]));
  f.child.emit("close", 0);
  await expect(result).resolves.toEqual(unicodeResponse);
});

it("flushes incomplete UTF-8 on close instead of silently dropping it", async () => {
  const f = fixture();
  const result = f.read({ type: "wsl", wslDistro: "Ubuntu" }, "messages", {});
  f.child.stdout.emit("data", Buffer.from("{}"));
  f.child.stdout.emit("data", Buffer.from([0xe4]));
  f.child.emit("close", 0);
  await expect(result).rejects.toThrow("invalid response");
});

it.each([0, 1])("enforces the raw stdout byte limit with %i excess bytes", async excess => {
  const f = fixture();
  const result = f.read({ type: "wsl", wslDistro: "Ubuntu" }, "messages", {});
  const text = "a".repeat(limits.MAX_REMOTE_OUTPUT_BYTES - 5 + excess) + "中";
  const bytes = Buffer.from(JSON.stringify(text), "utf8");
  f.child.stdout.emit("data", bytes.subarray(0, bytes.length - 3));
  f.child.stdout.emit("data", bytes.subarray(bytes.length - 3));
  f.child.emit("close", 0);
  if (excess) {
    await expect(result).rejects.toThrow("query failed");
    expect(f.child.kill).toHaveBeenCalled();
  } else {
    await expect(result).resolves.toBe(text);
    expect(f.child.kill).not.toHaveBeenCalled();
  }
});

it("routes WSL through its distribution and keeps the encoded script and request intact", async () => {
  const f = fixture();
  const result = f.read({ type: "wsl", wslDistro: "Ubuntu", id: "wsl-1" }, "list", { cwd: "/work/a b", limit: 50 });
  const [command, args, options] = f.spawn.mock.calls[0];
  expect(command).toBe("wsl.exe");
  expect(args.slice(0, 5)).toEqual(["-d", "Ubuntu", "--", "python3", "-c"]);
  expect(JSON.parse(Buffer.from(args.at(-1), "base64").toString())).toEqual({ cwd: "/work/a b", limit: 50 });
  expect(options.windowsHide).toBe(true);
  f.child.stdout.emit("data", Buffer.from('{"items":[],"nextCursor":null}'));
  f.child.emit("close", 0);
  await expect(result).resolves.toEqual({ items: [], nextCursor: null });
  expect(f.exec).not.toHaveBeenCalled();
});

it("kills a timed-out WSL child and ignores its later close event", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const result = f.read({ type: "wsl", wslDistro: "Ubuntu" }, "list", {});
  const rejection = expect(result).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(limits.REMOTE_TIMEOUT_MS);
  await rejection;
  expect(f.child.kill).toHaveBeenCalledTimes(1);
  f.child.emit("close", 1);
  expect(vi.getTimerCount()).toBe(0);
});

it("passes SSH timeout options and rejects malformed remote output", async () => {
  const f = fixture();
  f.exec.mockResolvedValue("not-json");
  await expect(f.read({ type: "ssh", id: "ssh-1" }, "messages", { conversationRef: "codex:test" })).rejects.toThrow("invalid response");
  expect(f.exec).toHaveBeenCalledWith("ssh-1", expect.stringContaining("python3 -c"), { actionName: "Agent conversation history", timeoutMs: limits.REMOTE_TIMEOUT_MS });
  expect(f.fsApi.readFileSync).toHaveBeenCalledWith("fixture.py");
  expect(f.spawn).not.toHaveBeenCalled();
});
