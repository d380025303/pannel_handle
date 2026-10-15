import { expect, it } from "vitest";
import sourceModule from "./transcript-source.cjs";

function harness(mib, provider = "codex") {
  const bytes = Buffer.alloc(mib * 1024 * 1024, 0x0a);
  const output = JSON.stringify({ main: { path: "remote", identity: "1:1", start: 0,
    offset: bytes.length, data: bytes.toString("base64") }, subagents: [] });
  const source = sourceModule.createTranscriptSource({ sshAgentTransport: {
    createReusableCommandClient: () => ({ exec: async () => output, close() {} })
  } });
  const tracker = { remote: true, provider, session: { id: "ssh" }, hostPath: "remote",
    offset: 0, fileIdentity: null, pendingBytes: Buffer.alloc(0), subagentReaders: new Map(),
    parser: source.createParser(provider) };
  return { source, tracker, bytes };
}

it.each([32, 60])("keeps timers running while decoding a %i MiB SSH response", async mib => {
  const { source, tracker, bytes } = harness(mib);
  let decodeTicks = 0;
  let firstDelay;
  const start = performance.now();
  const timer = setInterval(() => {
    firstDelay ??= performance.now() - start;
    if (tracker.cancelRemoteDecode) decodeTicks++;
  }, 1);
  try {
    await source.readAppendedBytes(tracker);
    expect(decodeTicks).toBeGreaterThan(1);
    expect(tracker.offset).toBe(bytes.length);
    expect(tracker.pendingBytes.length).toBe(0);
    console.info(`${mib} MiB: first timer ${firstDelay.toFixed(1)} ms, ${decodeTicks} ticks during decode`);
  } finally { clearInterval(timer); source.closeRemoteClient(tracker); }
}, 15000);

it("cancels an in-flight decode without updating reader state", async () => {
  const { source, tracker } = harness(32, "codebuddy");
  const read = source.readAppendedBytes(tracker);
  await Promise.resolve();
  expect(tracker.cancelRemoteDecode).toBeTypeOf("function");
  tracker.disposed = true;
  source.closeRemoteClient(tracker);
  expect(await read).toBe(false);
  expect(tracker.offset).toBe(0);
  expect(tracker.fileIdentity).toBeNull();
  expect(tracker.cancelRemoteDecode).toBeNull();
});

it.each(["{", "null", "{}"])("rejects invalid response %s without advancing offsets", async output => {
  const { source, tracker } = harness(0);
  tracker.remoteClient = { exec: async () => output, close() {} };
  try {
    await expect(source.readAppendedBytes(tracker)).rejects.toThrow();
    expect(tracker.offset).toBe(0);
    expect(tracker.cancelRemoteDecode).toBeNull();
  } finally { source.closeRemoteClient(tracker); }
});
