import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useGraphicalSession, type GraphicalViewProps } from "./useGraphicalSession";
import { PROTOCOL_VERSION, type GraphicalSnapshot } from "./types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["remove", "unmount", "thread", "session"].flatMap(exit =>
  ["before-ticket", "during-upload"].map(timing => ({ exit, timing }))))("cancels attachments on $exit $timing", async ({ exit, timing }) => {
  const send = vi.fn((_message: import("./types").ClientMessage) => true);
  let listener: Parameters<GraphicalViewProps["onGraphicalMessage"]>[0] = () => {};
  let signal: AbortSignal | undefined;
  const fetchUpload = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
    signal = options.signal as AbortSignal;
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }));
  vi.stubGlobal("fetch", fetchUpload);
  const props: GraphicalViewProps = {
    session: { id: "session", title: "Agent", type: "windows", runtimeMode: "app-server", agentProvider: "codex" },
    connectionEpoch: 1, send, onGraphicalMessage: callback => { listener = callback; return () => {}; },
    draft: "", setDraft: vi.fn(), submissionPending: false, onSubmitRequest: vi.fn()
  };
  const { result, unmount, rerender } = renderHook((value: GraphicalViewProps) => useGraphicalSession(value), { initialProps: props });
  const snapshot: GraphicalSnapshot = { threadId: "thread", provider: "codex", busy: false, archived: false,
    error: null, mode: "default", nativeMode: null, capabilities: {}, pendingPlan: null, items: [], approvals: [], questions: [] };
  act(() => listener({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "session", snapshot }));
  act(() => result.current.addFiles([new File(["hello"], "note.txt")] as unknown as FileList));
  const key = result.current.attachments[0].key;
  const prepare = send.mock.calls.map(call => call[0] as unknown as { type: string; requestId: string }).find(message => message.type === "graphical.upload.prepare")!;
  const leave = () => {
    if (exit === "remove") act(() => result.current.removeAttachment(key));
    else if (exit === "unmount") unmount();
    else if (exit === "session") rerender({ ...props, session: { ...props.session, id: "next-session" } });
    else act(() => listener({ v: PROTOCOL_VERSION, type: "graphical.snapshot", sessionId: "session",
      snapshot: { ...snapshot, threadId: "next-thread" } }));
  };
  if (timing === "before-ticket") leave();
  act(() => listener({ v: PROTOCOL_VERSION, type: "graphical.upload.ready", requestId: prepare.requestId, fileId: "file", url: "/upload" }));
  if (timing === "during-upload") {
    await waitFor(() => expect(fetchUpload).toHaveBeenCalledOnce());
    leave();
    expect(signal?.aborted).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.upload.discard", fileIds: ["file"] }));
  }
  if (timing !== "before-ticket" || !["unmount", "session"].includes(exit)) await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "graphical.upload.discard", fileIds: ["file"] })));
  if (timing === "before-ticket") expect(fetchUpload).not.toHaveBeenCalled();
  if (exit !== "unmount") expect(result.current.attachments).toEqual([]);
  expect(result.current.error).toBe("");
});
