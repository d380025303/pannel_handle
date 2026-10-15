// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTerminalInstances } from "./useTerminalInstances";

const mocks = vi.hoisted(() => ({ terminals: [] as {
  write: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  paste: ReturnType<typeof vi.fn>;
  keyHandler: (event: KeyboardEvent) => boolean;
}[] }));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: () => "exited" }) }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} proposeDimensions() { return undefined; } } }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  write = vi.fn(); dispose = vi.fn(); options = {}; rows = 30; element?: HTMLElement;
  dataHandler = (_data: string) => {};
  keyHandler = (_event: KeyboardEvent) => true;
  paste = vi.fn((text: string) => this.dataHandler(`paste:${text}`));
  constructor() { mocks.terminals.push(this); }
  loadAddon() {} focus() {} refresh() {} hasSelection() { return false; }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { this.keyHandler = handler; }
  onData(handler: (data: string) => void) { this.dataHandler = handler; }
  open(host: HTMLElement) { this.element = host; }
} }));
let output: (data: { id: string; seq: number; data: string }) => void;
let resolveHistory: (value: { data: string; seq: number }) => void;
let rejectHistory: (reason: Error) => void;
const theme = {};
function Harness() {
  const hook = useTerminalInstances({ activeId: "one", isVisible: true, terminalTheme: theme, sessions: [] });
  return <div onContextMenu={hook.handleTerminalContextMenu} ref={node => { if (node) hook.terminalHostRefs.current.set("one", node); }} />;
}
beforeEach(() => {
  mocks.terminals.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  window.clipboardApi = {
    readText: vi.fn(async () => "echo first\necho second\n"),
    pasteImageToSession: vi.fn(async () => ({ status: "empty" }))
  } as unknown as Window["clipboardApi"];
  window.terminalApi = {
    onData: vi.fn(callback => { output = callback; return () => {}; }),
    onExit: vi.fn(() => () => {}), onSizeOwner: vi.fn(() => () => {}), resize: vi.fn(), write: vi.fn(),
    getHistorySnapshot: vi.fn(() => new Promise((resolve, reject) => { resolveHistory = resolve; rejectHistory = reject; }))
  } as unknown as Window["terminalApi"];
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each(["Ctrl+V", "Shift+Insert", "context menu"])("routes %s text through xterm and its onData listener", async (source) => {
  const view = render(<Harness />);
  await act(async () => {
    if (source === "context menu") {
      fireEvent.contextMenu(view.container.firstChild!);
    } else {
      const event = new KeyboardEvent("keydown", source === "Ctrl+V"
        ? { key: "v", ctrlKey: true }
        : { key: "Insert", shiftKey: true });
      expect(mocks.terminals[0].keyHandler(event)).toBe(false);
    }
  });
  expect(mocks.terminals[0].paste).toHaveBeenCalledExactlyOnceWith("echo first\necho second\n");
  expect(window.terminalApi.write).toHaveBeenCalledExactlyOnceWith("one", "paste:echo first\necho second\n");
});
it.each([true, false])("uses real xterm paste protocol with bracketed paste %s", async (enabled) => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  const { Terminal } = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
  const terminal = new Terminal();
  const host = document.createElement("div");
  document.body.append(host);
  terminal.open(host);
  const input = vi.fn();
  terminal.onData(input);
  await new Promise<void>(resolve => terminal.write(enabled ? "\x1b[?2004h" : "\x1b[?2004l", resolve));
  terminal.paste("echo first\necho second\r\n");
  const text = "echo first\recho second\r";
  expect(input).toHaveBeenCalledExactlyOnceWith(enabled ? `\x1b[200~${text}\x1b[201~` : text);
  terminal.dispose();
  host.remove();
});
it("writes delayed history before buffered and continuing output", async () => {
  render(<Harness />);
  act(() => output({ id: "one", seq: 2, data: "NEW\r\n" }));
  expect(mocks.terminals[0].write).not.toHaveBeenCalled();
  await act(async () => resolveHistory({ data: "OLD\r\n", seq: 1 }));
  act(() => output({ id: "one", seq: 3, data: "NEXT\r\n" }));
  expect(mocks.terminals[0].write.mock.calls.flat().join("")).toBe("OLD\r\nNEW\r\nNEXT\r\n");
});
it("deduplicates buffered and late events covered by the snapshot", async () => {
  render(<Harness />);
  act(() => output({ id: "one", seq: 2, data: "NEW\r\n" }));
  await act(async () => resolveHistory({ data: "OLD\r\nNEW\r\n", seq: 2 }));
  act(() => output({ id: "one", seq: 2, data: "NEW\r\n" }));
  expect(mocks.terminals[0].write.mock.calls.flat().join("")).toBe("OLD\r\nNEW\r\n");
});
it("releases buffered output after a failed history request", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  render(<Harness />);
  act(() => output({ id: "one", seq: 2, data: "NEW" }));
  await act(async () => rejectHistory(new Error("unavailable")));
  act(() => output({ id: "one", seq: 3, data: "NEXT" }));
  expect(mocks.terminals[0].write.mock.calls.flat().join("")).toBe("NEWNEXT");
});
it("ignores a history response after disposal", async () => {
  const view = render(<Harness />);
  view.unmount();
  await act(async () => resolveHistory({ data: "OLD", seq: 1 }));
  expect(mocks.terminals[0].write).not.toHaveBeenCalled();
});
