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
      "codeBuddyCodexApi", "agentConversationApi", "launchTemplateApi", "mobileAccessApi", "hookConfigApi",
      "dingTalkApi", "clipboardApi", "externalLinkApi", "remoteFileApi", "remoteSystemApi", "skillsApi",
      "mcpApi", "agentUsageApi", "workBuddyCheckinApi", "agentTokenStatsApi", "remoteAgentApi",
      "fileTransferApi", "gitApi", "projectSearchApi", "ideaBridgeApi", "windowApi"
    ]));
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
