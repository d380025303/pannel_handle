// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { ProjectSearchApi, RemoteFileApi, TerminalSession } from "../../vite-env";
import { ProjectSearchModal } from "./ProjectSearchModal";
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("ignores Escape while a blocking dialog is open, then closes normally", async () => {
  window.projectSearchApi = {
    listDirectories: async () => ({ workspaceRoot: "/app", path: "/app", directories: [] })
  } as unknown as ProjectSearchApi;
  const session: TerminalSession = { id: "run", type: "windows", cwd: "/app", title: "test", shell: "", createdAt: 1 };
  const onClose = vi.fn();
  const search = <ProjectSearchModal mode="files" initialRoot="/app" session={session} onClose={onClose} onOpenPath={() => {}} />;
  const view = render(<I18nProvider locale="zh-CN">{search}<div role="dialog" aria-modal="true" /></I18nProvider>);
  await act(async () => {});
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  view.rerender(<I18nProvider locale="zh-CN">{search}</I18nProvider>);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it.each(["ssh", "windows"] as const)("cancels changed and unmounted file searches for %s", async type => {
  vi.useFakeTimers();
  const search = vi.fn<ProjectSearchApi["searchFiles"]>(() => new Promise<never>(() => {}));
  const cancelFileSearch = vi.fn(async () => true);
  window.projectSearchApi = {
    listDirectories: async () => ({ workspaceRoot: "/app", path: "/app", directories: [] }),
    searchWorkspaceEntries: search, searchFiles: search, cancelFileSearch
  } as unknown as ProjectSearchApi;
  window.remoteFileApi = { list: async () => [] } as unknown as RemoteFileApi;
  const session: TerminalSession = { id: "run", type, cwd: "/app", title: "test", shell: "", createdAt: 1 };
  const view = render(<I18nProvider locale="zh-CN"><ProjectSearchModal mode="files" initialRoot="/app" session={session} onClose={() => {}} onOpenPath={() => {}} /></I18nProvider>);
  await act(async () => {});
  const input = screen.getAllByRole("textbox")[1];
  fireEvent.change(input, { target: { value: "old" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(180); });
  const oldId = search.mock.calls[0]?.[4];
  expect(oldId).toEqual(expect.any(String));
  fireEvent.change(input, { target: { value: "new" } });
  expect(cancelFileSearch).toHaveBeenCalledWith("run", oldId);
  await act(async () => { await vi.advanceTimersByTimeAsync(180); });
  const newId = search.mock.calls[1]?.[4];
  expect(newId).not.toBe(oldId);
  view.unmount();
  expect(cancelFileSearch).toHaveBeenLastCalledWith("run", newId);
});
