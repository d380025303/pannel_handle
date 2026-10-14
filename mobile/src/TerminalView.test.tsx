import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalView } from "./TerminalView";
import type { ClientMessage, RuntimeSession } from "./types";

vi.mock("@xterm/xterm", () => ({ Terminal: class {
  element: HTMLElement | null = null;
  rows = 24;
  loadAddon() {}
  open(container: HTMLElement) { this.element = document.createElement("div"); container.append(this.element); }
  onData() { return { dispose() {} }; }
  focus() {}
  dispose() {}
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));

const session: RuntimeSession = { id: "terminal-1", title: "终端", type: "windows", runtimeMode: "terminal" };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("keeps paste text and the dialog open when sending fails, then clears it after success", () => {
  const send = vi.fn((_message: ClientMessage) => false);
  const onTerminalMessage = () => () => {};
  function TestView() {
    const [pasteText, setPasteText] = useState("");
    const [pasteOpen, setPasteOpen] = useState(false);
    return <TerminalView session={session} connectionEpoch={1} send={send} onTerminalMessage={onTerminalMessage}
      pasteText={pasteText} setPasteText={setPasteText} pasteOpen={pasteOpen} setPasteOpen={setPasteOpen} />;
  }
  render(<TestView />);
  fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("hello");
  expect(screen.getByRole("alert").textContent).toContain("连接已断开");
  send.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "粘贴" }));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
});

it("resubscribes to the current terminal after reconnect", () => {
  const send = vi.fn((_message: ClientMessage) => true);
  const onTerminalMessage = () => () => {};
  const props = { session, send, onTerminalMessage, pasteText: "", setPasteText: vi.fn(), pasteOpen: false, setPasteOpen: vi.fn() };
  const page = render(<TerminalView {...props} connectionEpoch={1} />);
  page.rerender(<TerminalView {...props} connectionEpoch={2} />);
  expect(send.mock.calls.filter(([message]) => message.type === "terminal.subscribe")).toHaveLength(2);
});

it("unsubscribes the previous session on switch and the current session on leaving the view", () => {
  const send = vi.fn((_message: ClientMessage) => true);
  const props = { send, onTerminalMessage: () => () => {}, pasteText: "", setPasteText: vi.fn(), pasteOpen: false, setPasteOpen: vi.fn() };
  const page = render(<TerminalView {...props} session={session} connectionEpoch={1} />);
  page.rerender(<TerminalView {...props} session={{ ...session, id: "terminal-2" }} connectionEpoch={1} />);
  page.unmount();
  expect(send.mock.calls.map(([message]) => message)).toEqual([
    { v: 8, type: "terminal.subscribe", sessionId: "terminal-1", lastSeq: undefined },
    { v: 8, type: "terminal.unsubscribe", sessionId: "terminal-1" },
    { v: 8, type: "terminal.subscribe", sessionId: "terminal-2", lastSeq: undefined },
    { v: 8, type: "terminal.unsubscribe", sessionId: "terminal-2" }
  ]);
});
