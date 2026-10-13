// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { installBrowserPreview } from "./installBrowserPreview";

describe("installBrowserPreview", () => {
  beforeEach(() => {
    installBrowserPreview();
  });

  it("installs every renderer bridge used by the application", () => {
    expect(Object.keys(window)).toEqual(expect.arrayContaining([
      "environmentApi", "terminalApi", "screenshotApi", "openRouterApi", "naraRouterApi", "miniMaxApi",
      "agentConversationApi", "codexAppServerApi", "codexPluginApi", "codexWorkspaceTrustApi", "launchTemplateApi", "mobileAccessApi", "hookConfigApi",
      "dingTalkApi", "clipboardApi", "externalLinkApi", "remoteFileApi", "remoteSystemApi", "skillsApi",
      "mcpApi", "agentUsageApi", "workBuddyCheckinApi", "agentTokenStatsApi", "remoteAgentApi",
      "fileTransferApi", "gitApi", "projectSearchApi", "ideaBridgeApi", "windowApi", "projectToolsApi"
    ]));
  });

  it("provides graphical preview panels and keeps their changes in memory", async () => {
    const snapshot = await window.codexAppServerApi.snapshot("preview");
    expect(snapshot.items.length).toBeGreaterThan(0);
    expect(snapshot.goal?.objective).toContain("浏览器预览");
    const catalog = await window.codexPluginApi.list("preview");
    expect(catalog.installed.length).toBeGreaterThan(0);
    const changed = await window.codexPluginApi.setEnabled("preview", "project", { plugin: "preview-tools", marketplace: "preview-marketplace", enabled: false });
    expect(changed.overrides[changed.pluginId].enabled).toBe(false);
    expect((await window.codexAppServerApi.readConfiguration("preview")).profiles.data?.length).toBeGreaterThan(0);
    await window.codexAppServerApi.setPermissionProfile("preview", "preview-workspace");
    expect((await window.codexAppServerApi.readConfiguration("preview")).runtime.permissionProfileId).toBe("preview-workspace");
    expect((await window.codexAppServerApi.listCapabilities("preview")).mcp[0].resources.length).toBeGreaterThan(0);
    expect((await window.codexAppServerApi.readPluginSkill("preview", "preview-tools", "preview-marketplace", "ui-review")).contents).toContain("浏览器预览");
    expect((await window.codexAppServerApi.listHistory("preview")).data.length).toBeGreaterThan(0);
    const terminals = await window.codexAppServerApi.listBackgroundTerminals("preview");
    await window.codexAppServerApi.terminateBackgroundTerminal("preview", terminals[0].processId);
    expect(await window.codexAppServerApi.listBackgroundTerminals("preview")).toEqual([]);
    await window.codexAppServerApi.setGoal("preview", { objective: "预览变更", status: "paused" });
    expect((await window.codexAppServerApi.getGoal("preview")).goal).toMatchObject({ objective: "预览变更", status: "paused" });
  });

  it("keeps workspace trust idle and prevents real Hook operations in browser preview", async () => {
    expect(await window.codexWorkspaceTrustApi.listPending()).toEqual([]);
    expect(window.codexWorkspaceTrustApi.onChanged(vi.fn())).toBeTypeOf("function");
    expect(window.codexWorkspaceTrustApi.onResolved(vi.fn())).toBeTypeOf("function");
    await expect(window.codexWorkspaceTrustApi.openHooks("preview")).rejects.toThrow("浏览器预览");
  });

  it("restores showcase sessions and publishes in-memory session changes", async () => {
    const saved = await window.terminalApi.loadSavedSessions();
    expect(saved.map((session) => session.type)).toEqual(["windows", "wsl", "ssh"]);

    const onChanged = vi.fn();
    const unsubscribe = window.terminalApi.onSessionsChanged(onChanged);
    const launched = await window.terminalApi.launchSessions(saved, "restore");

    expect(launched).toHaveLength(3);
    expect(onChanged).toHaveBeenLastCalledWith(expect.arrayContaining([
      expect.objectContaining({ title: "本地开发", type: "windows" }),
      expect.objectContaining({ title: "测试服务器", type: "ssh", sshConnectionState: "connected" })
    ]));

    const created = await window.terminalApi.createSession({ title: "临时预览" });
    await window.terminalApi.updateSession(created.id, { title: "已重命名" });
    expect(onChanged).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: created.id, title: "已重命名" })]));
    unsubscribe();
  });

  it("keeps config, window state and clipboard changes inside the preview runtime", async () => {
    const onMaximized = vi.fn();
    window.windowApi.onMaximizedChanged(onMaximized);
    window.windowApi.toggleMaximize();

    expect(await window.windowApi.isMaximized()).toBe(true);
    expect(onMaximized).toHaveBeenCalledWith(true);

    const config = await window.terminalApi.setConfig({ themeId: "light", sidebarWidth: 340 });
    expect(config).toEqual(expect.objectContaining({ themeId: "light", sidebarWidth: 340 }));

    await window.clipboardApi.writeText("preview-only");
    expect(await window.clipboardApi.readText()).toBe("preview-only");
  });
});
