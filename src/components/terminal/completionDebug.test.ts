import { describe, expect, it } from "vitest";
import { MAX_COMPLETION_DEBUG_ENTRIES, mergeCompletionDebugEvent, type CompletionDebugEntry } from "./completionDebug";

describe("completion debug event reducer", () => {
  it("merges request and response phases", () => {
    const pending = mergeCompletionDebugEvent([], {
      requestId: "r1",
      phase: "request",
      timestamp: 10,
      sessionId: "s1",
      request: { url: "https://example.test", method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
    });
    const completed = mergeCompletionDebugEvent(pending, {
      requestId: "r1",
      phase: "response",
      timestamp: 25,
      sessionId: "s1",
      status: "success",
      durationMs: 15,
      httpStatus: 200,
      responseBody: "{\"ok\":true}",
      completion: " next"
    });

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "success", durationMs: 15, httpStatus: 200, completion: " next" });
    expect(completed[0].request?.headers).not.toHaveProperty("Authorization");
  });

  it("keeps only the most recent entries", () => {
    let entries: CompletionDebugEntry[] = [];
    for (let index = 0; index < MAX_COMPLETION_DEBUG_ENTRIES + 5; index += 1) {
      entries = mergeCompletionDebugEvent(entries, {
        requestId: `r${index}`,
        phase: "request",
        timestamp: index,
        sessionId: "s1"
      });
    }
    expect(entries).toHaveLength(MAX_COMPLETION_DEBUG_ENTRIES);
    expect(entries[0].requestId).toBe("r5");
  });

  it("ignores completion phases without a captured request", () => {
    expect(mergeCompletionDebugEvent([], {
      requestId: "orphan",
      phase: "response",
      timestamp: 20,
      sessionId: "s1",
      status: "success"
    })).toEqual([]);
  });
});
