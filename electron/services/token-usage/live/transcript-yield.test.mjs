import { expect, it } from "vitest";
import liveModule from "./index.cjs";
import transcriptModule from "../agent-token-transcript.cjs";

const usage = (input, output) => JSON.stringify({ type: "event_msg", payload: {
  type: "token_count", info: { total_token_usage: {
    input_tokens: input, output_tokens: output, total_tokens: input + output
  } }
} });

it.each([[false, 32], [false, 63], [true, 32], [true, 63]])(
  "yields during %s remote / %i MiB restore and preserves baseline and deltas",
  async (remote, mib) => {
    const line = JSON.stringify({ type: "response_item", payload: {
      type: "function_call_output", call_id: "tool", output: "x".repeat(8192)
    } }) + "\n";
    const text = line.repeat(Math.floor((mib * 1024 * 1024 - 1024) / Buffer.byteLength(line))) + usage(100, 20) + "\r\n";
    let content = Buffer.from(text);
    let reads = 0;
    let remoteOffset = 0;
    const service = liveModule.createAgentTokenLiveModule({
      sshAgentTransport: { createReusableCommandClient: () => ({ close() {}, exec: async () => {
        reads += 1;
        const start = remoteOffset;
        remoteOffset = content.length;
        return JSON.stringify({ main: { path: "transcript.jsonl", identity: "1:1", start,
          offset: content.length, data: content.subarray(start).toString("base64") } });
      } }) },
      fsPromises: {
        stat: async () => ({ size: content.length }),
        open: async () => { reads += 1; return {
          read: async (target, offset, length, position) => {
            const bytes = content.subarray(position, position + length);
            bytes.copy(target, offset);
            return { bytesRead: bytes.length };
          }, close: async () => {}
        }; }
      }, setIntervalFn: () => 1, clearIntervalFn: () => {}
    });
    const event = eventName => service.handleEvent({ provider: "codex", eventName,
      session: { id: "large", type: remote ? "ssh" : "windows" },
      input: { session_id: "agent", transcript_path: "transcript.jsonl" }
    });
    let finished = false;
    let timerRanBeforeCompletion = false;
    const timer = setTimeout(() => { timerRanBeforeCompletion = !finished; }, 0);
    try {
      const { tracker } = event("SessionStart");
      const initialPoll = tracker.pollPromise;
      event("UserPromptSubmit");
      expect(tracker.pollPromise).toBe(initialPoll);
      await initialPoll;
      finished = true;
      await new Promise(resolve => setImmediate(resolve));
      expect(timerRanBeforeCompletion).toBe(true);
      expect(reads).toBe(1);
      const expected = transcriptModule.parseTranscriptText("codex", text);
      expect(tracker.parser.getResult()).toEqual(expected);
      expect(tracker.sessionBaseline).toEqual(expected.tokens);
      expect(service.getSnapshot("large").tokens.totalTokens).toBe(0);
      const delta = Buffer.from(usage(130, 30) + "\n");
      const split = delta.length - 3;
      content = Buffer.concat([content, delta.subarray(0, split)]);
      event("UserPromptSubmit");
      await tracker.pollPromise;
      expect(tracker.pendingBytes).toEqual(delta.subarray(0, split));
      expect(tracker.parser.getResult()).toEqual(expected);
      content = Buffer.concat([content, delta.subarray(split)]);
      await event("Stop").completion;
      expect(tracker.parser.getResult()).toEqual(transcriptModule.parseTranscriptText("codex", text + delta.toString()));
      expect(tracker.sessionBaseline).toEqual(expected.tokens);
      expect(service.getSnapshot("large")).toMatchObject({ state: "completed", tokens: { totalTokens: 40 } });
      expect(tracker.offset).toBe(content.length);
      expect(tracker.pendingBytes.length).toBe(0);
    } finally { clearTimeout(timer); service.shutdown(); }
  }, 15000
);
