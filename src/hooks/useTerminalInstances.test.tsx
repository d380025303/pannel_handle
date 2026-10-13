// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTerminalInstances } from "./useTerminalInstances";

const mocks = vi.hoisted(() => ({ terminals: [] as { write: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] }));
vi.mock("../i18n", () => ({ useI18n: () => ({ t: () => "exited" }) }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} proposeDimensions() { return undefined; } } }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  write = vi.fn(); dispose = vi.fn(); options = {}; rows = 30; element?: HTMLElement;
  constructor() { mocks.terminals.push(this); }
  loadAddon() {} attachCustomKeyEventHandler() {} onData() {} focus() {} refresh() {}
  open(host: HTMLElement) { this.element = host; }
} }));
let output: (data: { id: string; seq: number; data: string }) => void;
let resolveHistory: (value: { data: string; seq: number }) => void;
let rejectHistory: (reason: Error) => void;
const theme = {};
function Harness() {
  const hook = useTerminalInstances({ activeId: "one", isVisible: true, terminalTheme: theme, sessions: [] });
  return <div ref={node => { if (node) hook.terminalHostRefs.current.set("one", node); }} />;
}
beforeEach(() => {
  mocks.terminals.length = 0;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  window.terminalApi = {
    onData: vi.fn(callback => { output = callback; return () => {}; }),
    onExit: vi.fn(() => () => {}), onSizeOwner: vi.fn(() => () => {}), resize: vi.fn(),
    getHistorySnapshot: vi.fn(() => new Promise((resolve, reject) => { resolveHistory = resolve; rejectHistory = reject; }))
  } as unknown as Window["terminalApi"];
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
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
