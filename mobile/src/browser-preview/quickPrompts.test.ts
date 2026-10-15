import { expect, it } from "vitest";
import { PreviewSocket } from "./installBrowserPreview";
import type { ServerMessage } from "../types";

it("rejects stale prompt writes without changing records or notifying subscribers", async () => {
  const socket = new PreviewSocket();
  const messages: ServerMessage[] = [];
  socket.addEventListener("message", event => messages.push(JSON.parse((event as MessageEvent).data)));
  await Promise.resolve();
  async function request(operation: string, input = {}) {
    messages.length = 0;
    socket.send(JSON.stringify({ v: 8, type: "work-items.request", requestId: "test", operation, input }));
    await Promise.resolve();
    return [...messages];
  }
  try {
    const updated = await request("mutateQuickPrompt", { operation: "update", id: "prompt", version: 1, name: "更新", prompt: "正文", persistent: false });
    expect(updated.some(message => message.type === "work-items.changed")).toBe(true);
    for (const operation of ["update", "delete"]) {
      const rejected = await request("mutateQuickPrompt", { operation, id: "prompt", version: 1, name: "过期", prompt: "过期" });
      expect(rejected).toEqual([expect.objectContaining({ type: "error", message: expect.stringContaining("已修改或删除") })]);
    }
    const listed = await request("listQuickPrompts");
    expect(listed).toEqual([expect.objectContaining({ type: "work-items.result", result: [expect.objectContaining({ id: "prompt", version: 2, name: "更新", prompt: "正文", persistent: false })] })]);
  } finally { socket.close(); }
});
