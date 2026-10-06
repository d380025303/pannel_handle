import { useMemo, useRef } from "react";
import type { CodeBuddyMcpApi, CodeBuddyPluginApi, CodexAppServerApi, CodexVersionApi, McpApi } from "../../src/vite-env";
import type { CodeBuddyCommand } from "./types";
import type { useGraphicalSession } from "./useGraphicalSession";

// Inject adapters into shared dialogs; never install Electron APIs on the mobile window.
export function useCodeBuddyApi(controller: ReturnType<typeof useGraphicalSession>) {
  const latest = useRef(controller); latest.current = controller;
  return useMemo(() => {
    const ownerSession = controller.session.id, ownerThread = controller.snapshot?.threadId;
    let requestsPending = 0;
    const request = <T = unknown,>(command: CodeBuddyCommand, input: Record<string, unknown> = {}): Promise<T> => {
      if (latest.current.session.id !== ownerSession || latest.current.snapshot?.threadId !== ownerThread) return Promise.reject(new Error("对话已切换。"));
      requestsPending++;
      return latest.current.buddyRequest<T>(command, input).finally(() => { requestsPending--; });
    };
    const api = {
      getGoal: () => request("goal.read"), setGoal: (_id: string, input: { objective: string }) => request("goal.set", input),
      clearGoal: () => request("goal.clear"), refreshGoal: () => request("goal.refresh"),
      askSideQuestion: (_id: string, question: string) => request("side-question", { question }),
      cancelSideQuestion: (_id: string, requestId: string) => request("side-cancel", { requestId }),
      listScheduledTasks: () => request("tasks"), createScheduledTask: (_id: string, _thread: string, input: object) => request("task-create", { ...input }),
      deleteScheduledTask: (_id: string, _thread: string, taskId: string) => request("task-delete", { taskId }),
      listJobs: () => request("jobs"), jobDispatchContext: () => request("job-context"), listResumableJobs: () => request("job-history"),
      dispatchJob: (_id: string, input: object) => request("job-dispatch", { ...input }), resumeJob: (_id: string, sessionId: string) => request("job-resume", { sessionId }),
      jobAction: (_id: string, jobId: string, action: string, input?: object) => request("job-action", { jobId, action, input }),
      // Each mobile panel owns its bounded polling. It does not create desktop SSE watchers.
      onJobsEvent: (listener: (event: { cwd: string }) => void) => {
        const timer = setInterval(() => { if (!requestsPending) listener({ cwd: latest.current.session.cwd || "" }); }, 5000);
        return () => clearInterval(timer);
      },
      onJobTranscript: (listener: (event: object) => void) => { transcriptListener = listener; return () => { transcriptListener = null; }; },
      watchJob: async (_id: string, jobId: string) => {
        if (transcriptTimer) clearInterval(transcriptTimer);
        const generation = ++transcriptGeneration;
        const refresh = async () => {
          if (transcriptPending) return;
          transcriptPending = true;
          try {
            const value = await request<{ updates: Record<string, unknown>[] }>("job-transcript", { jobId });
            if (generation !== transcriptGeneration) return;
            const base = { cwd: latest.current.session.cwd || "", jobId };
            transcriptListener?.({ ...base, reset: true });
            for (const event of value.updates.slice(-1000)) transcriptListener?.({ ...base, event });
          } catch (cause) { if (generation === transcriptGeneration) transcriptListener?.({ cwd: latest.current.session.cwd || "", jobId, error: String(cause) }); }
          finally { transcriptPending = false; }
        };
        transcriptTimer = setInterval(() => void refresh(), 3000); await refresh();
      },
      unwatchJob: async () => { transcriptGeneration++; if (transcriptTimer) clearInterval(transcriptTimer); transcriptTimer = undefined; }
    } as unknown as CodexAppServerApi;
    let transcriptListener: ((event: object) => void) | null = null;
    let transcriptTimer: ReturnType<typeof setInterval> | undefined;
    let transcriptGeneration = 0, transcriptPending = false;
    const plugins: CodeBuddyPluginApi = {
      list: () => request("plugins"), reload: () => request("plugin-reload"),
      install: (_id, name, marketplace, scope) => request("plugin-install", { name, marketplace, scope }),
      uninstall: (_id, name, marketplace, scope) => request("plugin-uninstall", { name, marketplace, scope }),
      enable: (_id, name, marketplace, scope) => request("plugin-enable", { name, marketplace, scope }),
      disable: (_id, name, marketplace, scope) => request("plugin-disable", { name, marketplace, scope }),
      update: (_id, name, marketplace, scope) => request("plugin-update", { name, marketplace, scope }),
      addMarketplace: (_id, source, name, autoUpdate) => request("marketplace-add", { source, name, autoUpdate }),
      refreshMarketplace: (_id, name) => request("marketplace-refresh", { name }), removeMarketplace: (_id, name) => request("marketplace-remove", { name }),
      setAutoUpdate: (_id, name, enabled) => request("marketplace-auto", { name, enabled })
    };
    const version: CodexVersionApi = { check: (_id, force) => request("version", { force }), update: () => request("version-update") };
    const mcp: CodeBuddyMcpApi = {
      runtime: () => request("mcp-runtime"), restart: () => request("mcp-restart"),
      load: (_id, _thread, itemId) => request("app-load", { itemId }), read: (_id, _thread, itemId, uri) => request("app-read", { itemId, uri }),
      prepare: (_id, _thread, itemId, name, args) => request("app-prepare", { itemId, name, args }),
      resolve: (_id, token, approved) => request("app-resolve", { token, approved }), dispose: (_id, _thread, itemId) => request("app-dispose", { itemId }),
      images: (_id, _thread, itemId, images) => request("app-images", { itemId, images })
    };
    const config: McpApi = {
      list: input => request("mcp-config", { ...input }), save: input => request("mcp-save", { ...input }),
      remove: input => request("mcp-remove", { ...input }), reveal: input => request("mcp-reveal", { ...input }),
      copy: async () => { throw new Error("CodeBuddy 不支持跨 Agent 复制配置。"); }
    };
    return { api, plugins, version, mcp, config };
  }, [controller.session.id, controller.snapshot?.threadId]);
}
