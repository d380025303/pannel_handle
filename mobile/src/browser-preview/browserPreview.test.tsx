import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../App";
import { installPreviewTransport, createRemoteSocket } from "../remoteSocket";
import { installBrowserPreview, PreviewSocket } from "./installBrowserPreview";

vi.mock("../TerminalView", () => ({ TerminalView: () => <div>终端预览</div> }));

afterEach(() => { cleanup(); installPreviewTransport(); localStorage.clear(); vi.unstubAllGlobals(); });

it("enters business pages without a password or real WebSocket and simulates tasks, files and graphical submission", async () => {
  const realSocket = vi.fn(() => { throw new Error("Real server must not be contacted"); });
  Object.assign(realSocket, { OPEN: 1 }); vi.stubGlobal("WebSocket", realSocket);
  vi.stubGlobal("indexedDB", { deleteDatabase: vi.fn() });
  installBrowserPreview(); render(<App />);
  await screen.findByText("运行中的会话");
  await act(async () => {});
  expect(screen.queryByLabelText("移动访问密码")).toBeNull();
  expect(localStorage.getItem("pannel-handle-mobile-password")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "任务列表" }));
  await screen.findByText("检查移动端业务界面 · 长文本与弹窗滚动");
  fireEvent.click(screen.getByRole("button", { name: "详情" }));
  await screen.findByRole("dialog");
  expect((await screen.findAllByText(/浏览器内存预览：检查窄屏/)).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
  fireEvent.click(screen.getByRole("button", { name: "执行" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "确认执行" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "返回会话首页" }));
  fireEvent.click(screen.getByRole("button", { name: "电脑文件" }));
  fireEvent.click(await screen.findByRole("button", { name: /预览磁盘/ }));
  await screen.findByText("移动端窄屏布局与长文本验收说明.md");
  fireEvent.click(screen.getByRole("button", { name: "返回会话" }));
  fireEvent.click(screen.getByRole("button", { name: "打开图形会话 · 界面验收详情" }));
  await screen.findByLabelText("图形对话输入");
  fireEvent.change(screen.getByLabelText("图形对话输入"), { target: { value: "模拟交互验收" } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
  await screen.findByText(/已收到模拟消息：模拟交互验收/);
  expect(realSocket).not.toHaveBeenCalled();
});

it("keeps ordinary transport real and suppresses pending events after preview socket close", async () => {
  const realSocket = vi.fn(); vi.stubGlobal("WebSocket", realSocket);
  createRemoteSocket("ws://example.test"); expect(realSocket).toHaveBeenCalledWith("ws://example.test");
  const socket = new PreviewSocket(); const opened = vi.fn(); socket.addEventListener("open", opened);
  socket.close(); await Promise.resolve(); expect(opened).not.toHaveBeenCalled();
});

it("previews configuration, refreshes selected permissions and disables restricted choices", async () => {
  installBrowserPreview(); render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "打开图形会话 · 界面验收详情" }));
  fireEvent.click(await screen.findByRole("button", { name: "更多操作" }));
  fireEvent.click(screen.getByRole("button", { name: /配置与权限/ }));
  await screen.findByText(/工作区：.*移动端配置与权限验收/);
  expect(screen.getByText("配置层来源")).toBeTruthy();
  expect((screen.getByRole("button", { name: "完全访问" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "unrestricted" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "workspace" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "workspace" }).getAttribute("aria-pressed")).toBe("true"));
  fireEvent.click(screen.getByRole("button", { name: "刷新配置" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "刷新配置" }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByRole("button", { name: "workspace" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "只读" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "只读" }).getAttribute("aria-pressed")).toBe("true"));
  expect(screen.getByRole("button", { name: "workspace" }).getAttribute("aria-pressed")).toBe("false");
  expect(screen.queryByText("此操作尚未提供预览模拟数据。")).toBeNull();
});
