// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PromptTemplates } from "./PromptTemplates";
import type { ModuleOwnerApi } from "../../vite-env";
afterEach(cleanup);
it("defaults to preserving independent edits and publishes only explicitly selected tasks", async () => {
  const source = { id: "shared", name: "共享巡检", prompt: "新提示词", version: 2, createdAt: 1, updatedAt: 2, referenceCount: 2 };
  const tasks = [
    { templateId: "one", templateTitle: "项目一", ownerName: "桌面", taskId: "a", taskName: "巡检", prompt: "旧提示词", fingerprint: "a", modified: false, needsUpdate: true, appliedVersion: 1 },
    { templateId: "two", templateTitle: "项目二", ownerName: "移动", taskId: "b", taskName: "巡检", prompt: "定制提示词", fingerprint: "b", modified: true, needsUpdate: true, appliedVersion: 1 }
  ];
  const publish = vi.fn().mockResolvedValue({ updatedCount: 2 });
  window.moduleOwnerApi = { listPromptTemplates: vi.fn().mockResolvedValue([source]), previewPromptPublish: vi.fn().mockResolvedValue({ source, tasks }), publishPromptTemplate: publish } as unknown as ModuleOwnerApi;
  render(<PromptTemplates onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "一键发布" }));
  const region = await screen.findByRole("region", { name: "发布预览" });
  const boxes = within(region).getAllByRole("checkbox") as HTMLInputElement[];
  expect(boxes[0].checked).toBe(true); expect(boxes[1].checked).toBe(false);
  expect(within(region).getByText("已独立修改，覆盖将丢失修改")).toBeTruthy();
  expect(within(region).getAllByText("查看提示词差异")).toHaveLength(2);
  fireEvent.click(boxes[1]);
  fireEvent.click(screen.getByRole("button", { name: "发布到选中任务（2）" }));
  await waitFor(() => expect(publish).toHaveBeenCalledWith({ id: "shared", version: 2, targets: [{ templateId: "one", taskId: "a", fingerprint: "a" }, { templateId: "two", taskId: "b", fingerprint: "b" }] }));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "已更新 2 个自动任务。");
});
it("shows stale publication errors and retains the preview for refresh", async () => {
  const source = { id: "s", name: "模板", prompt: "更新", version: 2, referenceCount: 1 };
  window.moduleOwnerApi = { listPromptTemplates: vi.fn().mockResolvedValue([source]), previewPromptPublish: vi.fn().mockResolvedValue({ source, tasks: [{ templateId: "one", templateTitle: "项目", ownerName: "桌面", taskId: "a", taskName: "巡检", prompt: "旧文", fingerprint: "a", modified: false, needsUpdate: true }] }), publishPromptTemplate: vi.fn().mockRejectedValue(new Error("引用任务已变更，请重新预览后发布。")) } as unknown as ModuleOwnerApi;
  render(<PromptTemplates onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "一键发布" }));
  fireEvent.click(await screen.findByRole("button", { name: "发布到选中任务（1）" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "引用任务已变更，请重新预览后发布。");
  fireEvent.click(screen.getByRole("button", { name: "刷新发布预览" }));
  await waitFor(() => expect(window.moduleOwnerApi.previewPromptPublish).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "取消发布" }));
  expect(screen.getByRole("table", { name: "提示词模板列表" })).toBeTruthy();
});
it("edits in a child dialog, retains failed drafts and restores focus on Escape", async () => {
  const source = { id: "s", name: "巡检", prompt: "原文", version: 3, referenceCount: 0 };
  const save = vi.fn().mockRejectedValueOnce(new Error("保存失败")).mockResolvedValueOnce([{ ...source, name: "新名称" }]);
  const close = vi.fn();
  window.moduleOwnerApi = { listPromptTemplates: vi.fn().mockResolvedValue([source]), savePromptTemplate: save } as unknown as ModuleOwnerApi;
  render(<PromptTemplates onClose={close} />);
  const edit = await screen.findByRole("button", { name: "编辑模板" });
  edit.focus(); fireEvent.click(edit);
  const dialog = screen.getByRole("dialog", { name: "编辑提示词模板" });
  expect(screen.queryByRole("table")).toBeNull();
  fireEvent.change(within(dialog).getByLabelText("模板名称"), { target: { value: "新名称" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存模板" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "保存失败");
  expect(screen.getByLabelText("模板名称")).toHaveProperty("value", "新名称");
  fireEvent.click(screen.getByRole("button", { name: "保存模板" }));
  await screen.findByRole("status");
  expect(save).toHaveBeenLastCalledWith({ id: "s", version: 3, name: "新名称", prompt: "原文" });
  expect(document.activeElement).toBe(edit);
  fireEvent.click(edit);
  fireEvent.keyDown(screen.getByRole("dialog", { name: "编辑提示词模板" }), { key: "Escape" });
  expect(screen.getByRole("table", { name: "提示词模板列表" })).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
});
it("creates templates in a separate dialog and discards cancelled drafts", async () => {
  const save = vi.fn().mockResolvedValue([{ id: "new", name: "新增", prompt: "内容", version: 1, referenceCount: 0 }]);
  window.moduleOwnerApi = { listPromptTemplates: vi.fn().mockResolvedValue([]), savePromptTemplate: save } as unknown as ModuleOwnerApi;
  render(<PromptTemplates onClose={() => {}} />);
  await screen.findByText("暂无提示词模板。");
  fireEvent.click(screen.getByRole("button", { name: "新增提示词模板" }));
  fireEvent.change(screen.getByLabelText("模板名称"), { target: { value: "放弃" } });
  fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "新增提示词模板" }));
  expect(screen.getByLabelText("模板名称")).toHaveProperty("value", "");
  fireEvent.change(screen.getByLabelText("模板名称"), { target: { value: "新增" } });
  fireEvent.change(screen.getByLabelText("模板提示词"), { target: { value: "内容" } });
  fireEvent.click(screen.getByRole("button", { name: "保存模板" }));
  await screen.findByRole("status");
  expect(save).toHaveBeenCalledWith({ name: "新增", prompt: "内容" });
  expect(screen.getByRole("table").textContent).toContain("新增");
});
it("confirms deletion in a dialog and disables referenced templates", async () => {
  const sources = [{ id: "used", name: "引用模板", version: 1, referenceCount: 1 }, { id: "free", name: "未引用", version: 2, referenceCount: 0 }];
  const remove = vi.fn().mockRejectedValueOnce(new Error("删除失败")).mockResolvedValueOnce([sources[0]]);
  window.moduleOwnerApi = { listPromptTemplates: vi.fn().mockResolvedValue(sources), deletePromptTemplate: remove } as unknown as ModuleOwnerApi;
  render(<PromptTemplates onClose={() => {}} />);
  const buttons = await screen.findAllByRole("button", { name: "删除模板" });
  expect(buttons[0]).toHaveProperty("disabled", true);
  expect(buttons[0].title).toBe("请先解除任务引用");
  fireEvent.click(buttons[1]);
  fireEvent.click(screen.getByRole("button", { name: "取消删除" }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(buttons[1]);
  fireEvent.click(screen.getByRole("button", { name: "确认删除模板" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "删除失败");
  fireEvent.click(screen.getByRole("button", { name: "确认删除模板" }));
  await screen.findByRole("status");
  expect(remove).toHaveBeenLastCalledWith({ id: "free", version: 2 });
  expect(screen.queryByRole("dialog", { name: "删除提示词模板" })).toBeNull();
});
