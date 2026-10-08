import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { buildInvocation, createCodexAppServerSessionService } = require("./session-service.cjs");
const { createQuestionAnswerStore } = require("./question-answer-store.cjs");

function fakeProcess(received, respond) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.emit("exit", 0); };
  let buffer = "";
  child.stdin.on("data", chunk => {
    buffer += chunk.toString();
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const request = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      received.push(request);
      if (request.id == null) continue;
      const result = respond?.(request) ?? (request.method === "thread/start" ? { thread: { id: "thread-1", model: "test-model" } }
        : request.method === "model/list" ? { data: [{ id: "test-model", isDefault: true }] }
          : request.method === "turn/start" ? { turn: { id: "turn-1", status: "inProgress" } } : {});
      const reply = value => child.stdout.write(`${JSON.stringify(value?.__error ? { id: request.id, error: { message: value.__error } }
        : { id: request.id, result: value })}\n`);
      if (typeof result?.then === "function") result.then(reply);
      else reply(result);
    }
  });
  return child;
}

describe("Codex skill settings", () => {
  const session = { id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" };
  function fixture(respond, skillPath = "/remote/skills/review/SKILL.md") {
    const received = [];
    let enabled = true;
    const child = fakeProcess(received, request => {
      const custom = respond?.(request);
      if (custom !== undefined) return custom;
      if (request.method === "skills/list") return { data: [{ cwd: session.cwd, skills: [{ name: "review", path: skillPath, enabled }], errors: [] }] };
      if (request.method === "skills/config/write") { enabled = request.params.enabled; return {}; }
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    return { received, child, service, skillPath };
  }
  it.each(["C:\\skills\\review\\SKILL.md", "/remote/skills/review/SKILL.md"])("saves both states using the server path %s and rejects disabled references", async skillPath => {
    const f = fixture(undefined, skillPath);
    try {
      await f.service.start(session);
      await f.service.setSkillEnabled(session.id, skillPath, false);
      expect(await f.service.listSkills(session.id, true)).toMatchObject([{ enabled: false }]);
      await expect(f.service.submit(session.id, "$review", [], [{ kind: "skill", name: "review", path: skillPath, token: "$review" }])).rejects.toThrow("已不可用");
      await f.service.setSkillEnabled(session.id, skillPath, true);
      expect(await f.service.listSkills(session.id, true)).toMatchObject([{ enabled: true }]);
      expect(f.received.filter(value => value.method === "skills/config/write").map(value => value.params)).toEqual([
        { path: skillPath, enabled: false }, { path: skillPath, enabled: true }]);
      expect(f.received.filter(value => value.method === "skills/list").every(value => value.params.forceReload)).toBe(true);
    } finally { f.service.shutdown(); }
  });
  it("rejects invalid parameters, unknown paths, other providers and unavailable sessions before writing", async () => {
    const f = fixture();
    try {
      await f.service.start(session);
      for (const args of [["", true], ["bad\0path", true], [f.skillPath, "false"], [null, false]])
        await expect(f.service.setSkillEnabled(session.id, ...args)).rejects.toThrow("无效");
      await expect(f.service.setSkillEnabled(session.id, "/unlisted", true)).rejects.toThrow("已不可用");
      await f.service.submit(session.id, "working");
      await expect(f.service.setSkillEnabled(session.id, f.skillPath, false)).rejects.toThrow("正在运行");
      f.service.shutdown();
      await f.service.start({ ...session, agentProvider: "opencode" });
      await expect(f.service.setSkillEnabled(session.id, f.skillPath, false)).rejects.toThrow("仅 Codex");
      expect(f.received.some(value => value.method === "skills/config/write")).toBe(false);
    } finally { f.service.shutdown(); }
  });
  it("serializes writes, propagates errors and permits a later retry", async () => {
    let reply;
    let attempts = 0;
    const f = fixture(request => request.method === "skills/config/write" && ++attempts === 1
      ? new Promise(resolve => { reply = resolve; }) : undefined);
    try {
      await f.service.start(session);
      const first = f.service.setSkillEnabled(session.id, f.skillPath, false);
      const failed = expect(first).rejects.toThrow("write failed");
      const second = f.service.setSkillEnabled(session.id, f.skillPath, true);
      await vi.waitFor(() => expect(reply).toBeTypeOf("function"));
      expect(attempts).toBe(1);
      reply({ __error: "write failed" });
      await failed; await second;
      expect(attempts).toBe(2);
    } finally { f.service.shutdown(); }
  });
  it.each(["archive", "compact"])("rejects skill writes during %s", async state => {
    const f = fixture();
    try {
      await f.service.start(session);
      f.child.stdout.write(`${JSON.stringify(state === "archive"
        ? { method: "thread/archived", params: { threadId: "thread-1" } }
        : { method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { id: "compact", type: "contextCompaction" } } })}\n`);
      await expect(f.service.setSkillEnabled(session.id, f.skillPath, false)).rejects.toThrow(/不可|正在运行/);
      expect(f.received.some(value => value.method === "skills/config/write")).toBe(false);
    } finally { f.service.shutdown(); }
  });
  it("does not write when forced skill discovery fails", async () => {
    const f = fixture(request => request.method === "skills/list" ? { __error: "read failed" } : undefined);
    try {
      await f.service.start(session);
      await expect(f.service.setSkillEnabled(session.id, f.skillPath, false)).rejects.toThrow("read failed");
      expect(f.received.some(value => value.method === "skills/config/write")).toBe(false);
    } finally { f.service.shutdown(); }
  });
  it("rejects stale skill discovery after switching threads", async () => {
    let reply;
    const f = fixture(request => {
      if (request.method === "skills/list") return new Promise(resolve => { reply = resolve; });
      if (request.method === "thread/read" || request.method === "thread/resume") return { thread: { id: request.params.threadId, cwd: session.cwd, turns: [] } };
    });
    try {
      await f.service.start(session);
      const writing = f.service.setSkillEnabled(session.id, f.skillPath, false);
      const rejected = expect(writing).rejects.toThrow("已切换");
      await vi.waitFor(() => expect(reply).toBeTypeOf("function"));
      await f.service.resume(session.id, "thread-2");
      reply({ data: [{ cwd: session.cwd, skills: [{ name: "review", path: f.skillPath }] }] });
      await rejected;
      expect(f.received.some(value => value.method === "skills/config/write")).toBe(false);
    } finally { f.service.shutdown(); }
  });
});

describe("Windows sandbox setup", () => {
  function fixture(respond) {
    const received = [];
    const child = fakeProcess(received, respond);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    const emit = params => child.stdout.write(`${JSON.stringify({ method: "windowsSandbox/setupCompleted", params })}\n`);
    return { service, child, received, emit };
  }
  const session = { id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" };
  it.each(["elevated", "unelevated"])("starts %s and waits for completion while guarding conversation operations", async mode => {
    const { service, received, emit } = fixture(request => request.method === "windowsSandbox/setupStart" ? { started: true } : undefined);
    try {
      await service.start(session);
      expect((await service.setupWindowsSandbox("run-1", mode)).windowsSandboxSetup).toMatchObject({ mode, status: "running" });
      expect(received.find(value => value.method === "windowsSandbox/setupStart").params).toEqual({ mode });
      await expect(service.setupWindowsSandbox("run-1", mode)).rejects.toThrow("正在初始化");
      await expect(service.submit("run-1", "hello")).rejects.toThrow("正在初始化");
      await expect(service.setSkillEnabled("run-1", "/skills/review/SKILL.md", false)).rejects.toThrow("正在初始化");
      await expect(service.newThread("run-1")).rejects.toThrow("正在初始化");
      await expect(service.setFastMode("run-1", true)).rejects.toThrow("正在初始化");
      emit({ mode: mode === "elevated" ? "unelevated" : "elevated", success: true });
      expect(service.snapshot("run-1").windowsSandboxSetup.status).toBe("running");
      emit({ mode, success: true });
      expect(service.snapshot("run-1").windowsSandboxSetup).toMatchObject({ status: "succeeded", error: null });
      await service.submit("run-1", "hello");
      await expect(service.setupWindowsSandbox("run-1", mode)).rejects.toThrow("等待");
    } finally { service.shutdown(); }
  });
  it("preserves completion arriving before the request response", async () => {
    let reply;
    const { service, emit } = fixture(request => request.method === "windowsSandbox/setupStart" ? new Promise(resolve => { reply = resolve; }) : undefined);
    try {
      await service.start(session);
      const pending = service.setupWindowsSandbox("run-1", "elevated");
      emit({ mode: "elevated", success: true });
      reply({ started: true });
      expect((await pending).windowsSandboxSetup.status).toBe("succeeded");
    } finally { service.shutdown(); }
  });
  it("reports errors, retries failures, rejects invalid modes and exited processes", async () => {
    let result = { __error: "Method not found" };
    const { service, child, emit } = fixture(request => request.method === "windowsSandbox/setupStart" ? result : undefined);
    try {
      await service.start(session);
      await expect(service.setupWindowsSandbox("run-1", "bad")).rejects.toThrow("无效");
      expect((await service.setupWindowsSandbox("run-1", "elevated")).windowsSandboxSetup.error).toContain("升级 Codex");
      result = { started: false };
      expect((await service.setupWindowsSandbox("run-1", "elevated")).windowsSandboxSetup.error).toContain("未启动");
      result = { started: true };
      await service.setupWindowsSandbox("run-1", "unelevated");
      emit({ mode: "unelevated", success: false, error: "授权失败" });
      expect(service.snapshot("run-1").windowsSandboxSetup.error).toBe("授权失败");
      await service.setupWindowsSandbox("run-1", "elevated");
      child.emit("exit", 1);
      expect(service.snapshot("run-1").windowsSandboxSetup).toMatchObject({ status: "failed", error: expect.stringContaining("已退出") });
      await expect(service.setupWindowsSandbox("run-1", "elevated")).rejects.toThrow("已退出");
    } finally { service.shutdown(); }
  });
  it("rejects non-Windows sessions and non-Codex providers", async () => {
    const { service } = fixture();
    try {
      await service.start({ ...session, agentProvider: "other" });
      expect(service.snapshot("run-1").windowsSandboxSetup.available).toBe(false);
      await expect(service.setupWindowsSandbox("run-1", "elevated")).rejects.toThrow("仅本地 Windows");
      await expect(service.setupWindowsSandbox("missing", "elevated")).rejects.toThrow("仅本地 Windows");
      service.shutdown();
      await service.start({ ...session, type: "wsl", wslDistro: "Ubuntu", cwd: "/tmp/project" });
      expect(service.snapshot("run-1").windowsSandboxSetup.available).toBe(false);
      await expect(service.setupWindowsSandbox("run-1", "elevated")).rejects.toThrow("仅本地 Windows");
    } finally { service.shutdown(); }
  });
});

describe("Codex App Server session", () => {
  it.each([
    { type: "uncommittedChanges" }, { type: "baseBranch", branch: "main" },
    { type: "commit", sha: "abcdef1" }, { type: "custom", instructions: "检查异常处理" }
  ])("starts an inline review of $type and allows normal conversation after interruption", async target => {
    const received = [];
    const child = fakeProcess(received, request => request.method === "review/start"
      ? { reviewThreadId: "thread-1", turn: { id: "review-turn", status: "inProgress", items: [
        { id: "review-input", type: "userMessage", content: [{ type: "text", text: "Review" }] }
      ] } } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      service.setMode("run-1", "plan");
      await service.startReview("run-1", target);
      expect(received.find(value => value.method === "review/start").params).toEqual({ threadId: "thread-1", delivery: "inline", target });
      expect(service.snapshot("run-1")).toMatchObject({ reviewing: true, busy: true, mode: "plan" });
      await expect(service.startReview("run-1", target)).rejects.toThrow("正在运行");
      await expect(service.submit("run-1", "continue")).rejects.toThrow("审查正在进行");
      child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "review-turn", status: "inProgress" } } })}\n`);
      await service.interrupt("run-1");
      expect(received.find(value => value.method === "turn/interrupt").params.turnId).toBe("review-turn");
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "review-turn", status: "interrupted" } } })}\n`);
      expect(service.snapshot("run-1")).toMatchObject({ reviewing: false, busy: false, mode: "plan", pendingPlan: null });
      await service.submit("run-1", "continue");
      expect(received.some(value => value.method === "turn/start")).toBe(true);
    } finally { service.close("run-1"); }
  });

  it("does not resurrect a review that completed before its response or duplicate streamed items", async () => {
    let reply;
    const received = [];
    const child = fakeProcess(received, request => request.method === "review/start" ? new Promise(resolve => { reply = resolve; }) : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    const emit = (method, params) => child.stdout.write(`${JSON.stringify({ method, params: { threadId: "thread-1", ...params } })}\n`);
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      const pending = service.startReview("run-1", { type: "uncommittedChanges" });
      expect(service.snapshot("run-1").reviewing).toBe(true);
      emit("turn/started", { turn: { id: "r", status: "inProgress" } });
      emit("item/started", { turnId: "r", item: { id: "r", type: "enteredReviewMode", review: "改动" } });
      emit("item/completed", { turnId: "r", item: { id: "r", type: "exitedReviewMode", review: "审查完成" } });
      emit("turn/completed", { turn: { id: "r", status: "completed" } });
      reply({ reviewThreadId: "thread-1", turn: { id: "r", status: "inProgress", items: [] } });
      await pending;
      expect(service.snapshot("run-1")).toMatchObject({ busy: false, reviewing: false });
      expect(service.snapshot("run-1").items.map(item => item.type)).toEqual(["enteredReviewMode", "exitedReviewMode"]);
    } finally { service.close("run-1"); }
  });

  it("queues an early review interruption until the authoritative active turn id arrives", async () => {
    const received = [];
    const child = fakeProcess(received, request => request.method === "review/start"
      ? { reviewThreadId: "thread-1", turn: { id: "submission-id", status: "inProgress", items: [] } } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await service.startReview("run-1", { type: "uncommittedChanges" });
      await service.interrupt("run-1");
      expect(received.some(value => value.method === "turn/interrupt")).toBe(false);
      child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "actual-id", status: "inProgress" } } })}\n`);
      await vi.waitFor(() => expect(received.find(value => value.method === "turn/interrupt")?.params).toEqual({ threadId: "thread-1", turnId: "actual-id" }));
    } finally { service.close("run-1"); }
  });

  it("validates review targets before sending and unlocks after unsupported-method errors", async () => {
    const received = [];
    const child = fakeProcess(received, request => request.method === "review/start" ? { __error: "Method not found: review/start" } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      for (const target of [null, [], {}, { type: "unknown" }, { type: "custom", instructions: " " }, { type: "baseBranch", branch: 1 }, { type: "commit" }])
        await expect(service.startReview("run-1", target)).rejects.toThrow(/审查目标/);
      expect(received.some(value => value.method === "review/start")).toBe(false);
      await expect(service.startReview("run-1", { type: "uncommittedChanges" })).rejects.toThrow("Method not found");
      expect(service.snapshot("run-1")).toMatchObject({ busy: false, reviewing: false });
      await service.submit("run-1", "continue");
    } finally { service.close("run-1"); }
  });
  it("lists all background terminals and terminates only listed process ids", async () => {
    const received = [];
    const child = fakeProcess(received, request => {
      if (request.method === "thread/backgroundTerminals/list") return request.params.cursor
        ? { data: [{ itemId: "item-2", processId: "p-2", command: "serve", cwd: "C:\\project" }], nextCursor: null }
        : { data: [{ itemId: "item-1", processId: "p-1", command: "watch", cwd: "C:\\project" }], nextCursor: "page-2" };
      if (request.method === "thread/backgroundTerminals/terminate") return { terminated: true };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await expect(service.terminateBackgroundTerminal("run-1", "p-1")).rejects.toThrow("刷新后重试");
      expect((await service.listBackgroundTerminals("run-1")).map(item => item.processId)).toEqual(["p-1", "p-2"]);
      expect(received.filter(item => item.method === "thread/backgroundTerminals/list").map(item => item.params)).toEqual([
        { threadId: "thread-1", limit: 100 }, { threadId: "thread-1", limit: 100, cursor: "page-2" }
      ]);
      await expect(service.terminateBackgroundTerminal("run-1", "unknown")).rejects.toThrow("刷新后重试");
      await expect(service.terminateBackgroundTerminal("run-1", "p-2")).resolves.toEqual({ terminated: true });
      expect(received.find(item => item.method === "thread/backgroundTerminals/terminate").params)
        .toEqual({ threadId: "thread-1", processId: "p-2" });
      await expect(service.terminateBackgroundTerminal("run-1", "p-2")).rejects.toThrow("刷新后重试");
      await service.cleanBackgroundTerminals("run-1");
      expect(received.find(item => item.method === "thread/backgroundTerminals/clean").params).toEqual({ threadId: "thread-1" });
    } finally { service.close("run-1"); }
  });

  it("keeps background terminal errors and stale thread results from authorizing termination", async () => {
    const received = [];
    let fail = false;
    const child = fakeProcess(received, request => {
      if (request.method === "thread/backgroundTerminals/list") return fail ? { __error: "list failed" }
        : { data: [{ processId: "p-1" }], nextCursor: null };
      if (request.method === "thread/backgroundTerminals/terminate") return { __error: "terminate failed" };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await service.listBackgroundTerminals("run-1");
      await expect(service.terminateBackgroundTerminal("run-1", "p-1")).rejects.toThrow("terminate failed");
      fail = true;
      await expect(service.listBackgroundTerminals("run-1")).rejects.toThrow("list failed");
      expect(received.filter(item => item.method === "thread/backgroundTerminals/terminate")).toHaveLength(1);
    } finally { service.close("run-1"); }
  });

  it("rejects a background terminal list returned after switching threads", async () => {
    let reply;
    const child = fakeProcess([], request => {
      if (request.method === "thread/backgroundTerminals/list") return new Promise(resolve => { reply = resolve; });
      if (request.method === "thread/start") return { thread: { id: reply ? "thread-2" : "thread-1", model: "test-model" } };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      const pending = service.listBackgroundTerminals("run-1");
      await service.newThread("run-1");
      reply({ data: [{ processId: "p-old" }], nextCursor: null });
      await expect(pending).rejects.toThrow("已切换");
      await expect(service.terminateBackgroundTerminal("run-1", "p-old")).rejects.toThrow("刷新后重试");
    } finally { service.close("run-1"); }
  });
  it("broadcasts only changed items during streaming and keeps full snapshots for state changes", async () => {
    const received = [];
    const child = fakeProcess(received);
    const broadcast = vi.fn();
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      const streamId = service.snapshot("run-1").streamId;
      child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1",
        item: { id: "old", type: "agentMessage", text: "x".repeat(100000) } } })}\n`);
      child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1",
        item: { id: "new", type: "agentMessage", text: "" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").items).toHaveLength(2));
      broadcast.mockClear();
      child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: {
        threadId: "thread-1", itemId: "new", delta: "hello" } })}\n`);
      await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith("codex-app-server:delta", expect.any(Object)));
      const delta = broadcast.mock.calls.find(([channel]) => channel === "codex-app-server:delta")[1];
      expect(delta).toMatchObject({ id: "run-1", streamId, threadId: "thread-1",
        items: [], textDeltas: [{ itemId: "new", delta: "hello" }], turnDiffs: [] });
      expect(JSON.stringify(delta)).not.toContain("x".repeat(1000));
      expect(delta.revision).toBe(delta.baseRevision + 1);
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(broadcast).toHaveBeenCalledWith("codex-app-server:changed", expect.objectContaining({
        snapshot: expect.objectContaining({ revision: delta.revision + 1 }) })));
    } finally { service.close("run-1"); }
  });

  it("streams reasoning summaries by section and keeps the completed item authoritative", async () => {
    const child = fakeProcess([]);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    const emit = (method, params) => child.stdout.write(`${JSON.stringify({ method, params })}\n`);
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      emit("item/started", { threadId: "thread-1", turnId: "turn-1", item: { id: "reason-1", type: "reasoning" } });
      emit("item/reasoning/summaryPartAdded", { threadId: "thread-1", itemId: "reason-1", summaryIndex: 0 });
      emit("item/reasoning/summaryTextDelta", { threadId: "other-thread", itemId: "reason-1", summaryIndex: 0, delta: "wrong" });
      emit("item/reasoning/summaryTextDelta", { threadId: "thread-1", itemId: "reason-1", summaryIndex: 0, delta: "检查" });
      emit("item/reasoning/summaryTextDelta", { threadId: "thread-1", itemId: "reason-1", summaryIndex: 0, delta: "文件" });
      emit("item/reasoning/summaryPartAdded", { threadId: "thread-1", itemId: "reason-1", summaryIndex: 1 });
      emit("item/reasoning/summaryTextDelta", { threadId: "thread-1", itemId: "reason-1", summaryIndex: 1, delta: "运行测试" });
      await vi.waitFor(() => expect(service.snapshot("run-1").items[0].summary).toEqual(["检查文件", "运行测试"]));
      expect(service.snapshot("run-1").items[0].status).toBe("inProgress");
      emit("item/completed", { threadId: "thread-1", turnId: "turn-1",
        item: { id: "reason-1", type: "reasoning", summary: ["最终摘要"] } });
      await vi.waitFor(() => expect(service.snapshot("run-1").items[0].summary).toEqual(["最终摘要"]));
      expect(service.snapshot("run-1").items[0].status).toBe("completed");
    } finally { service.close("run-1"); }
  });

  it.each(["completed", "failed", "interrupted"])("settles empty reasoning when the turn is %s", async status => {
    const child = fakeProcess([]);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    const emit = (method, params) => child.stdout.write(`${JSON.stringify({ method, params })}\n`);
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      emit("item/started", { threadId: "thread-1", turnId: "turn-1", item: { id: "r", type: "reasoning", summary: [] } });
      emit("item/started", { threadId: "thread-1", turnId: "other", item: { id: "other", type: "reasoning", summary: [] } });
      emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status } });
      await vi.waitFor(() => expect(service.snapshot("run-1").items[0].status).toBe(status));
      expect(service.snapshot("run-1").items[1].status).toBe("inProgress");
    } finally { service.close("run-1"); }
  });

  it("keeps review entry and result as two ordered items when they share an id", async () => {
    const child = fakeProcess([]);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1",
        item: { id: "review-1", type: "enteredReviewMode", review: "当前改动" } } })}\n`);
      child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1",
        item: { id: "review-1", type: "exitedReviewMode", review: "发现一个问题" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").items.map(item => item.type))
        .toEqual(["enteredReviewMode", "exitedReviewMode"]));
    } finally { service.close("run-1"); }
  });

  it("restores completed Codex event items when a stored thread is resumed", async () => {
    const child = fakeProcess([], request => {
      if (request.method === "thread/read") return { thread: { id: "thread-2", cwd: "C:\\project" } };
      if (request.method === "thread/resume") return { thread: { id: "thread-2", cwd: "C:\\project", turns: [{
        id: "turn-2", status: "completed", items: [
          { id: "reason-2", type: "reasoning", summary: ["历史摘要"] },
          { id: "collab-2", type: "collabToolCall", tool: "spawn_agent", status: "completed" },
          { id: "image-2", type: "imageView", path: "C:/project/image.png" },
          { id: "review-2", type: "enteredReviewMode", review: "当前改动" },
          { id: "review-2", type: "exitedReviewMode", review: "历史审查" },
          { id: "compact-2", type: "contextCompaction" }
        ]
      }] } };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await service.resume("run-1", "thread-2");
      expect(service.snapshot("run-1").items).toMatchObject([
        { type: "reasoning", summary: ["历史摘要"], turnId: "turn-2", status: "completed" },
        { type: "collabToolCall", tool: "spawn_agent", turnId: "turn-2" },
        { type: "imageView", path: "C:/project/image.png", turnId: "turn-2" },
        { id: "review-2:enteredReviewMode", type: "enteredReviewMode", review: "当前改动", turnId: "turn-2" },
        { id: "review-2", type: "exitedReviewMode", review: "历史审查", turnId: "turn-2" },
        { type: "contextCompaction", status: "completed", turnId: "turn-2" }
      ]);
    } finally { service.close("run-1"); }
  });

  it("tracks current-thread MCP failures and reloads after OAuth completion", async () => {
    const received = [];
    const child = fakeProcess(received, request => request.method === "mcpServer/oauth/login"
      ? { authorizationUrl: "https://auth.example.com/connect" } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", agentProvider: "codex", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      child.stdout.write(`${JSON.stringify({ method: "mcpServer/startupStatus/updated", params: {
        threadId: "other-thread", name: "files", status: "failed", failureReason: "reauthenticationRequired" } })}\n`);
      expect(service.snapshot("run-1").mcpRuntime).toEqual([]);
      child.stdout.write(`${JSON.stringify({ method: "mcpServer/startupStatus/updated", params: {
        threadId: "thread-1", name: "files", status: "failed", error: "token expired", failureReason: "reauthenticationRequired" } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").mcpRuntime).toEqual([{
        name: "files", status: "failed", error: "token expired", failureReason: "reauthenticationRequired" }]));
      await expect(service.loginMcpServer("run-1", "files")).resolves.toEqual({ authorizationUrl: "https://auth.example.com/connect" });
      expect(received.find(item => item.method === "mcpServer/oauth/login").params).toEqual({ name: "files", threadId: "thread-1" });
      await expect(service.loginMcpServer("run-1", "files")).rejects.toThrow("正在授权");
      child.stdout.write(`${JSON.stringify({ method: "mcpServer/oauthLogin/completed", params: {
        threadId: "other-thread", name: "files", success: true } })}\n`);
      expect(received.some(item => item.method === "config/mcpServer/reload")).toBe(false);
      child.stdout.write(`${JSON.stringify({ method: "mcpServer/oauthLogin/completed", params: {
        threadId: "thread-1", name: "files", success: true } })}\n`);
      await vi.waitFor(() => expect(received.some(item => item.method === "config/mcpServer/reload")).toBe(true));
      child.stdout.write(`${JSON.stringify({ method: "mcpServer/startupStatus/updated", params: {
        threadId: "thread-1", name: "files", status: "ready" } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").mcpLogins).toEqual([]));
      expect(service.snapshot("run-1").mcpRuntime[0]).toMatchObject({ status: "ready", error: null, failureReason: null });
    } finally { service.close("run-1"); }
  });

  it("retains MCP authorization and reload errors for retry", async () => {
    const received = [];
    const child = fakeProcess(received, request => request.method === "mcpServer/oauth/login"
      ? { authorizationUrl: "file:///unsafe" } : request.method === "config/mcpServer/reload" ? { __error: "reload failed" } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", agentProvider: "codex", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await expect(service.loginMcpServer("run-1", "files")).rejects.toThrow("授权链接协议无效");
      expect(service.snapshot("run-1").mcpLogins[0]).toMatchObject({ name: "files", status: "failed" });
      await expect(service.reloadMcpServers("run-1")).rejects.toThrow("reload failed");
      expect(service.snapshot("run-1").mcpReload).toEqual({ status: "failed", error: "reload failed" });
      child.stdout.write(`${JSON.stringify({ method: "mcpServer/oauthLogin/completed", params: {
        threadId: "thread-1", name: "files", success: false, error: "access denied" } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").mcpLogins[0]).toMatchObject({ status: "failed", error: "access denied" }));
    } finally { service.close("run-1"); }
  });

  it("reads and mutates plugins through the current graphical session", async () => {
    const received = [];
    const child = fakeProcess(received, request => {
      if (request.method === "plugin/list") return { marketplaces: [{ name: "official", path: null, plugins: [{
        id: "figma@official", name: "figma", installed: true, enabled: true, source: { type: "remote" },
        interface: { displayName: "Figma", shortDescription: "Create designs" }
      }] }], marketplaceLoadErrors: [] };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "plugin-run", agentProvider: "codex", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      const catalog = await service.listPlugins("plugin-run");
      expect(catalog.marketplaces[0].plugins[0]).toMatchObject({ displayName: "Figma", installed: true, source: { type: "remote" } });
      expect(received.find(item => item.method === "plugin/list").params.cwds).toEqual(["C:\\project"]);
      await service.installPlugin("plugin-run", catalog.marketplaces[0].plugins[0]);
      expect(received.find(item => item.method === "plugin/install").params).toMatchObject({ pluginName: "figma", remoteMarketplaceName: "official" });
      await service.uninstallPlugin("plugin-run", "figma@official");
      expect(received.find(item => item.method === "plugin/uninstall").params).toEqual({ pluginId: "figma@official" });
      await service.addPluginMarketplace("plugin-run", "owner/repo");
      await service.refreshPluginMarketplace("plugin-run", "team");
      await service.removePluginMarketplace("plugin-run", "team");
      expect(received.find(item => item.method === "marketplace/add").params).toEqual({ source: "owner/repo" });
      expect(received.find(item => item.method === "marketplace/upgrade").params).toEqual({ marketplaceName: "team" });
      expect(received.find(item => item.method === "marketplace/remove").params).toEqual({ marketplaceName: "team" });
    } finally { service.close("plugin-run"); }
  });
  it("keeps a signed-out graphical session alive until device-code login finishes", async () => {
    const received = [];
    let signedIn = false;
    const child = fakeProcess(received, request => {
      if (request.method === "account/read") return signedIn
        ? { requiresOpenaiAuth: true, account: { type: "chatgpt", email: "user@example.com", planType: "plus" } }
        : { requiresOpenaiAuth: true, account: null };
      if (request.method === "account/login/start") return { type: "chatgptDeviceCode", loginId: "device-1",
        verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", agentProvider: "codex", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      expect(service.snapshot("run-1")).toMatchObject({ threadId: null, account: { status: "signedOut" } });
      expect(received.some(item => item.method === "thread/start")).toBe(false);
      await expect(service.submit("run-1", "hello")).rejects.toThrow("请先登录");
      await service.startLogin("run-1", "chatgptDeviceCode");
      signedIn = true;
      child.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { loginId: "device-1", success: true } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1")).toMatchObject({ threadId: "thread-1", account: { status: "signedIn" } }));
      expect(received.filter(item => item.method === "thread/start")).toHaveLength(1);
    } finally { service.close("run-1"); }
  });
  it("tracks manual compaction through the compaction item and turn completion", async () => {
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await service.compactThread("run-1");
      expect(received.at(-1)).toMatchObject({ method: "thread/compact/start", params: { threadId: "thread-1" } });
      expect(service.snapshot("run-1")).toMatchObject({ compacting: true, busy: true, compactionStatus: "running" });
      await expect(service.compactThread("run-1")).rejects.toThrow("正在运行");
      await expect(service.submit("run-1", "继续")).rejects.toThrow("正在压缩");
      child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "compact-turn" } } })}\n`);
      child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1", turnId: "compact-turn",
        item: { id: "compact-item", type: "contextCompaction", status: "inProgress" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").items.at(-1)).toMatchObject({ type: "contextCompaction" }));
      child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1", turnId: "compact-turn",
        item: { id: "compact-item", type: "contextCompaction", status: "completed" } } })}\n`);
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "compact-turn", status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1")).toMatchObject({ compacting: false, busy: false, compactionStatus: "completed" }));
      expect(service.snapshot("run-1").items.at(-1)).toMatchObject({ type: "contextCompaction", status: "completed" });
    } finally { service.close("run-1"); }
  });

  it("releases compaction state when the server rejects the request", async () => {
    const child = fakeProcess([], request => request.method === "thread/compact/start" ? { __error: "无法压缩" } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await expect(service.compactThread("run-1")).rejects.toThrow("无法压缩");
      expect(service.snapshot("run-1")).toMatchObject({ busy: false, compacting: false,
        compactionStatus: "failed", error: "无法压缩" });
    } finally { service.close("run-1"); }
  });

  it("reads and updates the persisted goal for the current thread only", async () => {
    const received = [];
    const goal = { threadId: "thread-1", objective: "完成任务", status: "active", tokenBudget: 2000,
      tokensUsed: 300, timeUsedSeconds: 12 };
    const child = fakeProcess(received, request => {
      if (request.method === "thread/goal/get") return { goal: request.params.threadId === "thread-1" ? goal : null };
      if (request.method === "thread/goal/set") return { goal: { ...goal, ...request.params } };
      if (request.method === "thread/read") return { thread: { id: "thread-2", cwd: "C:\\project" } };
      if (request.method === "thread/resume") return { thread: { id: "thread-2", turns: [] } };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await vi.waitFor(() => expect(service.snapshot("run-1").goal).toMatchObject(goal));
      await service.setGoal("run-1", { status: "paused", tokenBudget: 4000 });
      expect(received.filter(item => item.method === "thread/goal/set").at(-1).params).toEqual({
        threadId: "thread-1", status: "paused", tokenBudget: 4000
      });
      expect(service.snapshot("run-1").goal).toMatchObject({ status: "paused", tokensUsed: 300 });
      child.stdout.write(`${JSON.stringify({ method: "thread/goal/updated", params: { threadId: "thread-1",
        goal: { ...goal, status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").goal.status).toBe("completed"));
      await service.clearGoal("run-1");
      expect(received.filter(item => item.method === "thread/goal/clear").at(-1).params).toEqual({ threadId: "thread-1" });
      expect(service.snapshot("run-1").goal).toBeNull();
      await service.resume("run-1", "thread-2");
      await vi.waitFor(() => expect(service.snapshot("run-1")).toMatchObject({ threadId: "thread-2", goal: null }));
      child.stdout.write(`${JSON.stringify({ method: "thread/goal/updated", params: { threadId: "thread-1", goal } })}\n`);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(service.snapshot("run-1").goal).toBeNull();
      await expect(service.setGoal("run-1", { objective: "" })).rejects.toThrow("目标内容");
    } finally { service.close("run-1"); }
  });
  it("lists current-thread capabilities and sends validated skill and app references", async () => {
    const received = [];
    const respond = request => {
      if (request.method === "skills/list") return { data: [{ cwd: "C:\\project", skills: [
        { name: "review", path: "C:\\skills\\review\\SKILL.md", description: "Review", enabled: true, scope: "user" }], errors: [] }] };
      if (request.method === "app/installed") return { apps: [{ id: "github", runtimeName: "GitHub", enabled: true, callable: true }] };
      if (request.method === "app/list") return { data: [{ id: "github", name: "GitHub", description: "Code", isAccessible: true, isEnabled: true }], nextCursor: null };
      if (request.method === "mcpServerStatus/list") return { data: [{ name: "files", runtimeStatus: "connected", authStatus: "unsupported",
        tools: { read_file: { name: "read_file", description: "Read", inputSchema: {} } }, resources: [], resourceTemplates: [] }], nextCursor: null };
    };
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => fakeProcess(received, respond) });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      const beforeSkills = received.length;
      expect(await service.listSkills("run-1", true)).toEqual([{
        name: "review", path: "C:\\skills\\review\\SKILL.md", description: "Review", enabled: true, scope: "user"
      }]);
      expect(received.slice(beforeSkills).map(item => item.method)).toEqual(["skills/list"]);
      expect(received.at(-1).params.forceReload).toBe(true);
      expect(await service.listCapabilities("run-1")).toMatchObject({ skills: [{ name: "review" }], apps: [{ id: "github", callable: true }],
        mcp: [{ name: "files", tools: [{ name: "read_file" }] }] });
      expect(received.find(value => value.method === "app/list").params.threadId).toBe("thread-1");
      await service.submit("run-1", "$review $github inspect", [], [
        { kind: "skill", name: "review", path: "C:\\skills\\review\\SKILL.md", token: "$review" },
        { kind: "app", name: "GitHub", path: "app://github", token: "$github" }
      ]);
      expect(received.find(value => value.method === "turn/start").params.input).toEqual([
        { type: "text", text: "$review $github inspect" },
        { type: "skill", name: "review", path: "C:\\skills\\review\\SKILL.md" },
        { type: "mention", name: "GitHub", path: "app://github" }
      ]);
      await expect(service.submit("run-1", "$missing", [], [
        { kind: "skill", name: "missing", path: "C:\\other\\SKILL.md", token: "$missing" }
      ])).rejects.toThrow("已不可用");
    } finally { service.close("run-1"); }
  });
  it("selects a catalog model and restarts the same thread for template Fast mode", async () => {
    const received = [];
    const children = [];
    const invocations = [];
    const template = { id: "template-1", codexBackend: "openai", codexAppServerFastMode: false };
    const sessionStore = {
      getTemplate: () => template,
      updateLibrary: vi.fn((_id, changes) => Object.assign(template, changes))
    };
    const respond = request => {
      if (request.method === "model/list") return { data: [
        { id: "model-a", displayName: "Model A", isDefault: true, serviceTiers: [{ id: "priority" }],
          defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deep" }] },
        { id: "model-b", displayName: "Model B", serviceTiers: [],
          defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "medium", description: "Balanced" }] }
      ] };
      if (request.method === "thread/start") return { thread: { id: "thread-1", model: "model-a" } };
      if (request.method === "thread/resume") return { thread: { id: "thread-1", model: "model-a", turns: [] } };
    };
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, sessionStore,
      spawnProcess: (_command, args) => {
        invocations.push(args);
        const child = fakeProcess(received, respond);
        children.push(child);
        return child;
      } });
    try {
      await service.start({ id: "run-1", templateId: template.id, codexBackend: "openai", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      expect(service.snapshot("run-1").models).toEqual([
        { id: "model-a", displayName: "Model A", fastAvailable: true, defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "medium", description: "Balanced" }, { reasoningEffort: "high", description: "Deep" }] },
        { id: "model-b", displayName: "Model B", fastAvailable: false, defaultReasoningEffort: "low",
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "medium", description: "Balanced" }] }
      ]);
      expect(service.snapshot("run-1").effort).toBe("medium");
      expect(service.setEffort("run-1", "high").effort).toBe("high");
      expect(template.codexAppServerEffort).toBe("high");
      expect(() => service.setEffort("run-1", "max")).toThrow("当前模型支持");
      await expect(service.setFastMode("run-1", true)).resolves.toMatchObject({ fastMode: true, threadId: "thread-1" });
      expect(template.codexAppServerFastMode).toBe(true);
      expect(invocations.at(-1).at(-1)).toContain("service_tier=\"priority\"");
      await service.setModel("run-1", "model-b");
      expect(template).toMatchObject({ codexAppServerModel: "model-b", codexAppServerEffort: "low", codexAppServerFastMode: false });
      expect(service.snapshot("run-1").effort).toBe("low");
      service.setEffort("run-1", "medium");
      expect(service.snapshot("run-1").effort).toBe("medium");
      expect(invocations.at(-1).at(-1)).toContain("service_tier=\"default\"");
      await expect(service.setFastMode("run-1", true)).rejects.toThrow("不支持快速模式");
      await service.submit("run-1", "hello");
      expect(received.filter(request => request.method === "turn/start").at(-1).params.model).toBe("model-b");
      expect(received.filter(request => request.method === "turn/start").at(-1).params.effort).toBe("medium");
    } finally { service.close("run-1"); }
  });
  it("runs local SSH bridge threads and attachments in the local workspace", async () => {
    const received = [];
    const child = fakeProcess(received, request => request.method === "thread/read"
      ? { thread: { id: "old-thread", cwd: "C:\\bridge" } }
      : request.method === "thread/resume"
        ? { thread: { id: "old-thread", model: "test-model", turns: [] } }
        : undefined);
    const spawnProcess = vi.fn(() => child);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {}, getSession: () => ({ id: "bridge", type: "ssh" }),
        setAppServerConnectionState: vi.fn(), listSessions: () => [{ id: "bridge" }] },
      broadcast: () => {}, spawnProcess });
    const session = { id: "bridge", type: "ssh", agentLocation: "local", cwd: "/srv/project", initialCommand: "remote command" };
    const runtime = { localBridge: true, workspaceCwd: "C:\\bridge", shell: "powershell.exe",
      codexCommand: "codex -c 'developer_instructions=\"remote only\"'", runtimeEnv: { PANNEL_HANDLE_REMOTE_AGENT_TOKEN: "secret" } };
    try {
      await service.start(session, runtime);
      expect(spawnProcess).toHaveBeenCalledWith("powershell.exe", expect.any(Array), expect.objectContaining({ cwd: "C:\\bridge" }));
      expect(spawnProcess.mock.calls[0][1].at(-1)).not.toContain("remote command");
      expect(received.find(request => request.method === "thread/start").params.cwd).toBe("C:\\bridge");
      expect(service.getWorkspaceCwd("bridge")).toBe("C:\\bridge");
      await service.listHistory("bridge");
      expect(received.find(request => request.method === "thread/list" && !request.params.ancestorThreadId).params.cwd).toBe("C:\\bridge");
      await service.resume("bridge", "old-thread");
      await service.submit("bridge", "Inspect the remote workspace");
      expect(received.find(request => request.method === "turn/start").params.sandboxPolicy.writableRoots).toEqual(["C:\\bridge"]);
    } finally { service.close("bridge"); }
  });
  it("previews only attached files and restores preview links from user message content", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-codex-preview-"));
    const textPath = path.join(directory, "notes.txt");
    const imagePath = path.join(directory, "picture.png");
    const secretPath = path.join(directory, "other.txt");
    const largePath = path.join(directory, "large.txt");
    const binaryPath = path.join(directory, "archive.zip");
    fs.writeFileSync(textPath, "hello preview");
    fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));
    fs.writeFileSync(secretPath, "not attached");
    fs.writeFileSync(largePath, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2]));
    const child = fakeProcess([], request => {
      if (request.method === "thread/read") return { thread: { id: "old-thread", cwd: "C:\\project" } };
      if (request.method === "thread/resume") return { thread: { id: "old-thread", turns: [{ items: [{
        id: "history-user", type: "userMessage", content: [
          { type: "text", text: `检查\n\n请读取以下附件文件：${JSON.stringify(textPath)}` },
          { type: "localImage", path: imagePath },
          { type: "text", text: "然后继续" }
        ] }] }] } };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await expect(service.previewAttachment("run-1", textPath)).rejects.toThrow("当前会话");
      service.allowFiles("run-1", [textPath, imagePath, largePath, binaryPath]);
      expect(await service.previewAttachment("run-1", textPath)).toEqual({ kind: "text", text: "hello preview" });
      expect(await service.previewAttachment("run-1", imagePath)).toMatchObject({ kind: "image", dataUrl: expect.stringMatching(/^data:image\/png;base64,/) });
      expect(await service.previewAttachment("run-1", largePath)).toMatchObject({ kind: "too_large", limit: 2 * 1024 * 1024 });
      expect(await service.previewAttachment("run-1", binaryPath)).toEqual({ kind: "unsupported" });
      await service.resume("run-1", "old-thread");
      expect(service.snapshot("run-1").items[0]).toMatchObject({ text: "检查然后继续", attachments: [
        { path: textPath, name: "notes.txt" }, { path: imagePath, name: "picture.png" }
      ] });
      expect(service.snapshot("run-1").items[0].parts.map(part => part.type)).toEqual(["text", "image", "text"]);
      expect(await service.previewAttachment("run-1", textPath)).toEqual({ kind: "text", text: "hello preview" });
      await expect(service.previewAttachment("run-1", secretPath)).rejects.toThrow("当前会话");
      fs.rmSync(textPath);
      await expect(service.previewAttachment("run-1", textPath)).rejects.toThrow();
    } finally { service.close("run-1"); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("publishes live token totals and clears them when starting another thread", async () => {
    const child = fakeProcess([]);
    const changes = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: (channel, payload) => changes.push({ channel, payload }),
      spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    const usage = outputTokens => ({ total: { inputTokens: 100, cachedInputTokens: 20, outputTokens,
      reasoningOutputTokens: 3, totalTokens: 100 + outputTokens }, last: { inputTokens: 10, cachedInputTokens: 2,
      outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 15 }, modelContextWindow: 128000 });
    child.stdout.write(`${JSON.stringify({ method: "thread/tokenUsage/updated", params: {
      threadId: "thread-1", turnId: "turn-1", tokenUsage: usage(10) } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").tokenUsage?.total.outputTokens).toBe(10));
    expect(service.snapshot("run-1").tokenUsage).toMatchObject({ total: { inputTokens: 100, cachedInputTokens: 20 }, modelContextWindow: 128000 });
    expect(changes.some(change => change.channel === "codex-app-server:changed" && change.payload.snapshot.tokenUsage?.total.outputTokens === 10)).toBe(true);
    child.stdout.write(`${JSON.stringify({ method: "thread/tokenUsage/updated", params: {
      threadId: "other-thread", turnId: "turn-1", tokenUsage: usage(999) } })}\n`);
    await new Promise(resolve => setImmediate(resolve));
    expect(service.snapshot("run-1").tokenUsage.total.outputTokens).toBe(10);
    await service.newThread("run-1");
    expect(service.snapshot("run-1").tokenUsage).toBeNull();
    service.close("run-1");
  });

  it("retains usage replayed before a history resume response", async () => {
    let child;
    const recorded = vi.fn();
    child = fakeProcess([], request => {
      if (request.method === "thread/read") return { thread: { id: "old-thread", cwd: "C:\\project" } };
      if (request.method === "thread/resume") {
        child.stdout.write(`${JSON.stringify({ method: "thread/tokenUsage/updated", params: { threadId: "old-thread",
          turnId: "old-turn", tokenUsage: { total: { inputTokens: 50, cachedInputTokens: 10, outputTokens: 8,
            reasoningOutputTokens: 1, totalTokens: 58 }, last: { inputTokens: 50, cachedInputTokens: 10,
            outputTokens: 8, reasoningOutputTokens: 1, totalTokens: 58 } } } })}\n`);
        return { thread: { id: "old-thread", model: "test-model", turns: [] } };
      }
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child,
      onTokenUsage: recorded });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    const restored = await service.resume("run-1", "old-thread");
    expect(restored.tokenUsage?.total.outputTokens).toBe(8);
    expect(recorded).toHaveBeenCalledWith(expect.objectContaining({ threadId: "old-thread", baseline: true }));
    service.close("run-1");
  });

  it("forwards cumulative App Server usage with history and reset baselines", async () => {
    const recorded = vi.fn();
    let nextThread = 0;
    const child = fakeProcess([], request => {
      if (request.method === "thread/start") return { thread: { id: `thread-${++nextThread}`, model: "test-model" } };
      if (request.method === "thread/read") return { thread: { id: "history", cwd: "C:\\project" } };
      if (request.method === "thread/resume") return { thread: { id: "history", model: "test-model", turns: [] } };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child,
      onTokenUsage: recorded });
    const sendUsage = (threadId, totalTokens) => child.stdout.write(`${JSON.stringify({ method: "thread/tokenUsage/updated",
      params: { threadId, tokenUsage: { total: { inputTokens: totalTokens - 10, outputTokens: 10, totalTokens },
        last: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } } } })}\n`);
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project", title: "Work" });
      sendUsage("thread-1", 100);
      await vi.waitFor(() => expect(recorded).toHaveBeenCalledTimes(1));
      expect(recorded).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "thread-1", baseline: false,
        tokens: expect.objectContaining({ totalTokens: 100 }) }));
      sendUsage("wrong-thread", 999);
      await new Promise(resolve => setImmediate(resolve));
      expect(recorded).toHaveBeenCalledTimes(1);
      await service.resume("run-1", "history");
      sendUsage("history", 500);
      await vi.waitFor(() => expect(recorded).toHaveBeenCalledTimes(2));
      expect(recorded).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "history", baseline: true }));
      sendUsage("history", 530);
      await vi.waitFor(() => expect(recorded).toHaveBeenCalledTimes(3));
      expect(recorded).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "history", baseline: false }));
      service.resetUsageBaselines();
      expect(recorded).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "history", baseline: true,
        tokens: expect.objectContaining({ totalTokens: 530 }) }));
      await service.newThread("run-1");
      sendUsage("thread-2", 20);
      await vi.waitFor(() => expect(recorded).toHaveBeenCalledTimes(5));
      expect(recorded).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "thread-2", baseline: false }));
    } finally { service.close("run-1"); }
  });

  it.skipIf(process.platform !== "win32")("keeps command and configured variables in the launched process", () => {
    const invocation = buildInvocation({ type: "windows", shell: process.env.ComSpec || "cmd.exe", cwd: process.cwd(),
      initialCommand: "set CODEX_TEST_FROM_COMMAND=from-command" },
    { codexCommand: "node -p process.env.CODEX_TEST_FROM_COMMAND+process.env.CODEX_TEST_VALUE" },
    { CODEX_TEST_VALUE: "configured" });
    const result = spawnSync(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("from-commandconfigured");
  });
  it("runs startup commands in the same shell and passes configured environment", () => {
    const windows = buildInvocation({ type: "windows", shell: "powershell.exe", cwd: "C:\\project", initialCommand: "$env:FROM_START='yes'" },
      { codexCommand: "codex" }, { CUSTOM: "value" });
    expect(windows.args.at(-1)).toContain("$env:FROM_START='yes'");
    expect(windows.args.at(-1)).toContain("codex app-server");
    expect(windows.env.CUSTOM).toBe("value");
    const wsl = buildInvocation({ type: "wsl", wslDistro: "Ubuntu", cwd: "/repo", initialCommand: "export FROM_START=yes" },
      { codexCommand: "codex" }, { CUSTOM: "value" });
    expect(wsl.args).toContain("/repo");
    expect(wsl.args).toContain("-lic");
    expect(wsl.args.at(-1)).toContain("export FROM_START=yes");
    expect(wsl.args.at(-1)).toContain("exec codex app-server");
    expect(wsl.env.WSLENV).toContain("CUSTOM/u");
  });
  it("reports WSL App Server startup output without exposing configured secrets", async () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const service = createCodexAppServerSessionService({
      environmentService: { resolve: () => ({ CODEX_TEST_TOKEN: "private-token-value" }) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child
    });
    const started = service.start({ id: "wsl-failed", type: "wsl", wslDistro: "ubuntu", cwd: "/repo" });
    child.stderr.write("CLI failed with private-token-value\n");
    child.emit("exit", 127);
    await expect(started).rejects.toThrow("启动输出：CLI failed with [已隐藏]");
    expect(child.kill).toHaveBeenCalled();
  });

  it("initializes, starts a thread, sends a turn, and resolves approval once", async () => {
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({
      environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} },
      broadcast: () => {},
      spawnProcess: () => child
    });
    const session = { id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" };
    await service.start(session);
    expect(service.snapshot("run-1").threadId).toBe("thread-1");
    await service.submit("run-1", "Hello");
    expect(received.find(item => item.method === "turn/start").params.input[0].text).toBe("Hello");
    expect(received.find(item => item.method === "turn/start").params.summary).toBe("auto");
    expect(received.find(item => item.method === "turn/start").params).not.toHaveProperty("effort");
    expect(received.find(item => item.method === "turn/start").params.collaborationMode).toEqual({ mode: "default", settings: { model: "test-model", developer_instructions: null } });
    child.stdout.write(`${JSON.stringify({ id: 42, method: "item/commandExecution/requestApproval", params: { command: "pnpm test" } })}\n`);
    await new Promise(resolve => setImmediate(resolve));
    expect(service.snapshot("run-1").approvals).toHaveLength(1);
    service.resolveApproval("run-1", 42, true);
    expect(received.at(-1)).toEqual({ id: 42, result: { decision: "accept" } });
    service.close("run-1");
  });

  it("maps command, file, and permission approval decisions explicitly", async () => {
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    try {
      const emit = (id, method, params = {}) => child.stdout.write(`${JSON.stringify({ id, method,
        params: { threadId: "thread-1", turnId: "turn-1", ...params } })}\n`);
      emit(41, "item/commandExecution/requestApproval", { availableDecisions: ["accept", "acceptForSession", "decline", "cancel",
        "acceptWithExecpolicyAmendment"], proposedExecpolicyAmendment: ["pnpm", "test"] });
      await vi.waitFor(() => expect(service.snapshot("run-1").approvals).toHaveLength(1));
      expect(() => service.resolveApproval("run-1", 41, "arbitrary")).toThrow("无效的审批选择");
      expect(service.snapshot("run-1").approvals).toHaveLength(1);
      service.resolveApproval("run-1", 41, "acceptWithExecpolicyAmendment");
      expect(received.at(-1)).toEqual({ id: 41, result: { decision: {
        acceptWithExecpolicyAmendment: { execpolicy_amendment: ["pnpm", "test"] } } } });
      emit(42, "item/commandExecution/requestApproval", { availableDecisions: ["decline", "cancel"] });
      await vi.waitFor(() => expect(service.snapshot("run-1").approvals).toHaveLength(1));
      expect(() => service.resolveApproval("run-1", 42, "acceptForSession")).toThrow("不允许");
      service.resolveApproval("run-1", 42, "cancel");
      expect(received.at(-1)).toEqual({ id: 42, result: { decision: "cancel" } });
      emit(43, "item/fileChange/requestApproval");
      await vi.waitFor(() => expect(service.snapshot("run-1").approvals).toHaveLength(1));
      expect(() => service.resolveApproval("run-1", 43, "acceptWithExecpolicyAmendment")).toThrow("无效的审批选择");
      service.resolveApproval("run-1", 43, "acceptForSession");
      expect(received.at(-1)).toEqual({ id: 43, result: { decision: "acceptForSession" } });
      emit(44, "item/commandExecution/requestApproval", { proposedExecpolicyAmendment: [] });
      await vi.waitFor(() => expect(service.snapshot("run-1").approvals).toHaveLength(1));
      expect(() => service.resolveApproval("run-1", 44, "acceptWithExecpolicyAmendment")).toThrow("没有有效");
      service.resolveApproval("run-1", 44, false);
      expect(received.at(-1)).toEqual({ id: 44, result: { decision: "decline" } });
      const permissions = { network: { enabled: true } };
      emit(45, "item/permissions/requestApproval", { permissions });
      await vi.waitFor(() => expect(service.snapshot("run-1").approvals).toHaveLength(1));
      expect(() => service.resolveApproval("run-1", 45, "cancel")).toThrow("无效的权限确认选择");
      service.resolveApproval("run-1", 45, "acceptForSession");
      expect(received.at(-1)).toEqual({ id: 45, result: { permissions, scope: "session" } });
      emit(46, "item/permissions/requestApproval", { permissions });
      await vi.waitFor(() => expect(service.snapshot("run-1").approvals).toHaveLength(1));
      service.resolveApproval("run-1", 46, true);
      expect(received.at(-1)).toEqual({ id: 46, result: { permissions, scope: "turn" } });
      emit(47, "item/permissions/requestApproval", { permissions });
      await vi.waitFor(() => expect(service.snapshot("run-1").approvals).toHaveLength(1));
      service.resolveApproval("run-1", 47, "decline");
      expect(received.at(-1)).toEqual({ id: 47, result: { permissions: {}, scope: "turn" } });
      emit(48, "item/fileChange/requestApproval");
      await vi.waitFor(() => expect(service.snapshot("run-1").approvals).toHaveLength(1));
      child.stdin.end();
      expect(() => service.resolveApproval("run-1", 48, "decline")).toThrow("已退出");
      expect(service.snapshot("run-1").approvals).toHaveLength(1);
    } finally { service.close("run-1"); }
  });

  it("keeps MCP form and URL requests pending until the user responds", async () => {
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    try {
      expect(received.find(item => item.method === "initialize").params.capabilities.mcpServerOpenaiFormElicitation).toBe(true);
      await service.submit("run-1", "Connect the server");
      const form = { threadId: "thread-1", turnId: "turn-1", serverName: "calendar", mode: "form",
        message: "Select a calendar", requestedSchema: { type: "object", properties: { calendar: { type: "string" } }, required: ["calendar"] } };
      child.stdout.write(`${JSON.stringify({ id: 81, method: "mcpServer/elicitation/request", params: form })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").elicitations).toHaveLength(1));
      expect(received.some(item => item.id === 81 && item.result)).toBe(false);
      service.resolveElicitation("run-1", 81, "accept", { calendar: "Team" });
      expect(received.at(-1)).toEqual({ id: 81, result: { action: "accept", content: { calendar: "Team" } } });
      expect(() => service.resolveElicitation("run-1", 81, "decline")).toThrow("已失效");
      child.stdout.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 81 } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").elicitations).toHaveLength(0));

      child.stdout.write(`${JSON.stringify({ id: 82, method: "mcpServer/elicitation/request", params: {
        threadId: "thread-1", turnId: "turn-1", serverName: "calendar", mode: "url", message: "Authorize",
        url: "https://example.com/authorize", elicitationId: "auth-1" } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").elicitations).toHaveLength(1));
      service.resolveElicitation("run-1", 82, "cancel", { unexpected: true });
      expect(received.at(-1)).toEqual({ id: 82, result: { action: "cancel", content: null } });
    } finally { service.close("run-1"); }
  });

  it("expires MCP requests and reports unsupported server requests as protocol errors", async () => {
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    try {
      await service.submit("run-1", "Connect");
      child.stdout.write(`${JSON.stringify({ id: 91, method: "mcpServer/elicitation/request", params: {
        threadId: "thread-1", turnId: "turn-1", serverName: "calendar", mode: "url", message: "Authorize",
        url: "https://example.com/authorize" } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").elicitations).toHaveLength(1));
      child.stdout.write(`${JSON.stringify({ id: 92, method: "item/tool/call", params: { threadId: "thread-1", secret: "do-not-log" } })}\n`);
      await vi.waitFor(() => expect(received.find(item => item.id === 92 && item.error)).toMatchObject({ error: { code: -32601 } }));
      expect(service.snapshot("run-1").diagnostics.at(-1).payload).toEqual({ method: "item/tool/call" });
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1",
        turn: { id: "turn-1", status: "interrupted" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").elicitations).toHaveLength(0));
      expect(() => service.resolveElicitation("run-1", 91, "accept")).toThrow("已失效");
    } finally { service.close("run-1"); }
  });

  it("steers consecutive messages and images into the active turn without losing either message", async () => {
    const received = [];
    const child = fakeProcess(received, request => request.method === "turn/steer" ? { turnId: "turn-1" } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "wsl", wslDistro: "Ubuntu", shell: "bash", cwd: "/repo" });
    try {
      await service.submit("run-1", "开始");
      const image = "/repo/.pannel-handle-images/steer.png";
      service.allowPastedImage("run-1", image);
      await service.submit("run-1", "先检查测试", [image]);
      await service.submit("run-1", "再检查文档");
      expect(received.filter(item => item.method === "turn/start")).toHaveLength(1);
      const steers = received.filter(item => item.method === "turn/steer");
      expect(steers).toHaveLength(2);
      expect(steers[0].params).toEqual({ threadId: "thread-1", expectedTurnId: "turn-1", input: [
        { type: "text", text: "先检查测试" }, { type: "localImage", path: image }
      ] });
      expect(service.snapshot("run-1").items.filter(item => item.type === "userMessage")).toHaveLength(3);
      for (const [id, text] of [["user-1", "开始"], ["user-2", "先检查测试"], ["user-3", "再检查文档"]])
        child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1",
          item: { id, type: "userMessage", content: [{ type: "text", text }] } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").items.find(item => item.id === "user-3")).toBeTruthy());
      expect(service.snapshot("run-1").items.filter(item => item.type === "userMessage")).toHaveLength(3);
      expect(service.snapshot("run-1").items.find(item => item.id === "user-2").attachments).toEqual([
        { path: image, name: "steer.png" }
      ]);
    } finally { service.close("run-1"); }
  });

  it("preserves interleaved text and images in the request and restored user message", async () => {
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "wsl", wslDistro: "Ubuntu", shell: "bash", cwd: "/repo" });
    try {
      const first = "/repo/.pannel-handle-images/first.png";
      const second = "/repo/.pannel-handle-images/second.png";
      service.allowPastedImage("run-1", first);
      service.allowPastedImage("run-1", second);
      await service.submit("run-1", "甲乙丙", [first, second], [], [
        { type: "text", text: "甲" }, { type: "image", path: first }, { type: "text", text: "乙" },
        { type: "image", path: second }, { type: "text", text: "丙" }]);
      const content = received.find(item => item.method === "turn/start").params.input;
      expect(content).toEqual([{ type: "text", text: "甲" }, { type: "localImage", path: first },
        { type: "text", text: "乙" }, { type: "localImage", path: second }, { type: "text", text: "丙" }]);
      child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1",
        item: { id: "user-1", type: "userMessage", content } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").items.find(item => item.id === "user-1")?.parts).toHaveLength(5));
      expect(service.snapshot("run-1").items.filter(item => item.type === "userMessage")).toHaveLength(1);
      expect(service.snapshot("run-1").items.find(item => item.id === "user-1").parts.map(part => part.type)).toEqual([
        "text", "image", "text", "image", "text"]);
    } finally { service.close("run-1"); }
  });

  it("keeps the active turn running when a steer is rejected", async () => {
    const received = [];
    const child = fakeProcess(received, request => request.method === "turn/steer" ? { __error: "turn/steer rejected" } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    try {
      await service.submit("run-1", "开始");
      await expect(service.submit("run-1", "补充")).rejects.toThrow("turn/steer rejected");
      expect(service.snapshot("run-1").busy).toBe(true);
      expect(service.snapshot("run-1").items.filter(item => item.type === "userMessage").map(item => item.text)).toEqual(["开始"]);
    } finally { service.close("run-1"); }
  });

  it("starts a new turn when the previous turn completes before the follow-up is sent", async () => {
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    try {
      await service.submit("run-1", "开始");
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").busy).toBe(false));
      await service.submit("run-1", "继续");
      expect(received.filter(item => item.method === "turn/start")).toHaveLength(2);
      expect(received.some(item => item.method === "turn/steer")).toBe(false);
    } finally { service.close("run-1"); }
  });

  it.each(["item/tool/requestUserInput", "tool/requestUserInput"])("keeps %s pending until resolved and sends all structured answers once", async method => {
    const received = [];
    const child = fakeProcess(received);
    const statuses = [];
    const service = createCodexAppServerSessionService({
      environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: value => statuses.push(value) },
      broadcast: () => {}, spawnProcess: () => child
    });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    await service.submit("run-1", "Ask me");
    child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } })}\n`);
    child.stdout.write(`${JSON.stringify({ id: 42, method, params: {
      threadId: "thread-1", turnId: "turn-1", questions: [
        { id: "framework", header: "框架", question: "选择框架", isOther: true,
          options: [{ label: "React", description: "使用 React" }] },
        { id: "details", header: "细节", question: "补充说明", options: null }
      ] } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(1));
    expect(statuses.at(-1)).toMatchObject({ status: "e_prompt", eventName: "AppServerQuestion" });
    expect(received.some(item => item.id === 42 && item.result?.answers)).toBe(false);
    expect(() => service.answerQuestion("run-1", 42, { framework: { answers: ["React"] } })).toThrow("请回答所有问题");
    const answers = { framework: { answers: ["React", "user_note: 继续"] }, details: { answers: ["user_note: 保持简单"] } };
    service.answerQuestion("run-1", 42, answers);
    expect(received.at(-1)).toEqual({ id: 42, result: { answers } });
    expect(service.snapshot("run-1").questions[0].submitting).toBe(true);
    expect(service.snapshot("run-1").items.at(-1)).toMatchObject({ type: "questionAnswer", status: "submitted", questions: [
      { id: "framework", answers: ["React", "user_note: 继续"] },
      { id: "details", answers: ["user_note: 保持简单"] }
    ] });
    expect(() => service.answerQuestion("run-1", 42, answers)).toThrow("问题请求已失效");
    child.stdout.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 42 } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(0));
    expect(service.snapshot("run-1").items.at(-1).status).toBe("completed");
    child.stdout.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 42 } })}\n`);
    await new Promise(resolve => setImmediate(resolve));
    expect(service.snapshot("run-1").items.filter(item => item.type === "questionAnswer")).toHaveLength(1);
    expect(statuses.at(-1)).toMatchObject({ status: "running", eventName: "AppServerTurn" });
    service.close("run-1");
  });

  it("persists answered questions in history without saving secret answers", async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-codex-questions-"));
    let store = createQuestionAnswerStore({ userData });
    const processFor = threadId => fakeProcess([], request => {
      if (request.method === "thread/start") return { thread: { id: threadId, model: "test-model" } };
      if (request.method === "thread/read") return { thread: { id: request.params.threadId, cwd: "C:\\project" } };
      if (request.method === "thread/resume") return { thread: { id: request.params.threadId, model: "test-model", turns: [{ id: "turn-1", items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "先提问" }] },
        { id: "agent-1", type: "agentMessage", text: "回答后继续" }
      ] }] } };
    });
    const createService = child => createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child, questionAnswerStore: store });
    let child = processFor("thread-1");
    let service = createService(child);
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await service.submit("run-1", "先提问");
      child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } })}\n`);
      child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1",
        item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "先提问" }] } } })}\n`);
      child.stdout.write(`${JSON.stringify({ id: 42, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1", questions: [
        { id: "choice", header: "选项", question: "选哪个？" },
        { id: "secret", header: "密钥", question: "输入密钥", isSecret: true }
      ] } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(1));
      service.answerQuestion("run-1", 42, { choice: { answers: ["React"] }, secret: { answers: ["top-secret"] } });
      expect(store.list("thread-1")[0].item.questions).toEqual([
        { id: "choice", header: "选项", question: "选哪个？", answers: ["React"] },
        { id: "secret", header: "密钥", question: "输入密钥", answers: ["••••••"] }
      ]);
      child.stdout.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 42 } })}\n`);
      await vi.waitFor(() => expect(store.list("thread-1")[0].item.status).toBe("completed"));
      service.close("run-1");
      store.close();
      store = createQuestionAnswerStore({ userData });
      child = processFor("new-thread");
      service = createService(child);
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      const restored = await service.resume("run-1", "thread-1");
      expect(restored.items.map(item => item.type)).toEqual(["userMessage", "questionAnswer", "agentMessage"]);
      expect(restored.items[1]).toMatchObject({ status: "completed", questions: [
        { answers: ["React"] }, { answers: ["••••••"] }
      ] });
      expect(JSON.stringify(restored.items)).not.toContain("top-secret");
    } finally {
      service.close("run-1");
      store.close();
      fs.rmSync(userData, { recursive: true, force: true });
    }
  });

  it("keeps a question retryable when its local record cannot be saved", async () => {
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child,
      questionAnswerStore: { save: () => { throw new Error("磁盘不可写"); }, remove: vi.fn() } });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await service.submit("run-1", "Ask me");
      child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } })}\n`);
      child.stdout.write(`${JSON.stringify({ id: 42, method: "item/tool/requestUserInput", params: { threadId: "thread-1", turnId: "turn-1",
        questions: [{ id: "q", header: "问题", question: "回答？" }] } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(1));
      expect(() => service.answerQuestion("run-1", 42, { q: { answers: ["是"] } })).toThrow("磁盘不可写");
      expect(service.snapshot("run-1").questions[0].submitting).toBe(false);
      expect(service.snapshot("run-1").items.some(item => item.type === "questionAnswer")).toBe(false);
      expect(received.some(item => item.id === 42 && item.result?.answers)).toBe(false);
    } finally { service.close("run-1"); }
  });

  it("removes Question when the server resolves it or the turn ends", async () => {
    const child = fakeProcess([]);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    await service.submit("run-1", "Ask me");
    child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1" } } })}\n`);
    const question = requestId => child.stdout.write(`${JSON.stringify({ id: requestId, method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1", questions: [{ id: "q", header: "Q", question: "?" }] } })}\n`);
    question(41);
    await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(1));
    child.stdout.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread-1", requestId: 41 } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(0));
    question(42);
    await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(1));
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").questions).toHaveLength(0));
    expect(() => service.answerQuestion("run-1", 42, { q: { answers: ["yes"] } })).toThrow("问题请求已失效");
    service.close("run-1");
  });

  it("lists current-project history and resumes its stored messages", async () => {
    const received = [];
    const child = fakeProcess(received, request => {
      if (request.method === "thread/start") return { thread: { id: "new-thread", model: "test-model" } };
      if (request.method === "thread/list") return request.params.isPinned ? { data: [], nextCursor: null }
        : { data: [{ id: "old-thread", name: "旧对话", updatedAt: 123, source: "cli", status: { type: "notLoaded" } }], nextCursor: "next" };
      if (request.method === "thread/read") return { thread: { id: "old-thread", cwd: "C:\\project" } };
      if (request.method === "thread/resume") return { thread: { id: "old-thread", model: "test-model", turns: [{ items: [
        { id: "user-1", type: "userMessage", content: [{ type: "text", text: "之前的问题" }] },
        { id: "answer-1", type: "agentMessage", text: "之前的回答" },
        { id: "plan-1", type: "plan", text: "# 历史计划" }
      ] }] } };
      return {};
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    expect(await service.listHistory("run-1")).toMatchObject({ data: [{ id: "old-thread", title: "旧对话", updatedAt: 123, source: "cli", status: "notLoaded" }], nextCursor: expect.any(String) });
    expect(received.find(item => item.method === "thread/list" && !item.params.ancestorThreadId).params).toMatchObject({ cwd: "C:\\project", sourceKinds: ["cli", "vscode", "appServer"] });
    const restored = await service.resume("run-1", "old-thread");
    expect(restored.threadId).toBe("old-thread");
    expect(restored.items.map(item => item.text)).toEqual(["之前的问题", "之前的回答", "# 历史计划"]);
    await vi.waitFor(() => expect(received.some(item => item.method === "thread/unsubscribe" && item.params.threadId === "new-thread")).toBe(true));
    service.close("run-1");
  });

  it("reads the first user input from history without resuming or using its title", async () => {
    const received = [];
    const child = fakeProcess(received, request => {
      if (request.method === "thread/start") return { thread: { id: "current-thread", model: "test-model" } };
      if (request.method === "thread/read") return { thread: {
        id: request.params.threadId, cwd: request.params.threadId === "other-project" ? "C:\\other" : "C:\\project",
        name: "已重命名的标题", turns: [{ items: [
          { id: "agent-1", type: "agentMessage", text: "系统回复" },
          { id: "user-1", type: "userMessage", content: [
            { type: "text", text: "最初的问题\n第二行\n\n请读取以下附件文件：\"C:\\\\project\\\\notes.txt\"" }
          ] },
          { id: "user-2", type: "userMessage", content: [{ type: "text", text: "后续问题" }] }
        ] }] } };
      return {};
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    expect(await service.readInitialUserInput("run-1", "old-thread")).toEqual({
      text: "最初的问题\n第二行", attachments: [{ path: "C:\\project\\notes.txt", name: "notes.txt" }]
    });
    expect(received.find(item => item.method === "thread/read").params).toEqual({ threadId: "old-thread", includeTurns: true });
    expect(received.some(item => item.method === "thread/resume")).toBe(false);
    expect(service.snapshot("run-1").threadId).toBe("current-thread");
    await expect(service.readInitialUserInput("run-1", "other-project")).rejects.toThrow("只能读取当前项目");
    service.close("run-1");
  });

  it("returns pinned history a page at a time before ordinary history", async () => {
    const received = [];
    const child = fakeProcess(received, request => {
      if (request.method !== "thread/list") return undefined;
      if (request.params.ancestorThreadId) return { data: [], nextCursor: null };
      if (request.params.isPinned) return request.params.cursor
        ? { data: [{ id: "pinned-2", name: "置顶二", isPinned: true }], nextCursor: null }
        : { data: [{ id: "pinned-1", name: "置顶一", isPinned: true }], nextCursor: "pin-next" };
      return request.params.cursor
        ? { data: [{ id: "ordinary-2", name: "普通二" }], nextCursor: null }
        : { data: [{ id: "ordinary-1", name: "普通一" }], nextCursor: "ordinary-next" };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      const first = await service.listHistory("run-1");
      expect(first.data.map(item => item.id)).toEqual(["pinned-1"]);
      expect(received.filter(item => item.method === "thread/list" && !item.params.ancestorThreadId)).toHaveLength(2);
      const second = await service.listHistory("run-1", first.nextCursor);
      expect(second.data.map(item => item.id)).toEqual(["pinned-2", "ordinary-1"]);
      const third = await service.listHistory("run-1", second.nextCursor);
      expect(third.data.map(item => item.id)).toEqual(["ordinary-2"]);
      expect(third.nextCursor).toBeNull();
      await expect(service.listHistory("run-1", first.nextCursor, true)).rejects.toThrow("无效的历史会话游标");
    } finally { service.close("run-1"); }
  });

  it("requests pinned and ordinary history together on the first page", async () => {
    const received = [];
    let releasePinned;
    const pinned = new Promise(resolve => { releasePinned = resolve; });
    const child = fakeProcess(received, request => {
      if (request.method !== "thread/list") return undefined;
      if (request.params.ancestorThreadId) return { data: [], nextCursor: null };
      if (request.params.isPinned) return pinned;
      releasePinned({ data: [], nextCursor: null });
      return { data: [{ id: "game4-thread", name: "game4 历史" }], nextCursor: null };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      const history = await service.listHistory("run-1");
      expect(received.filter(item => item.method === "thread/list" && !item.params.ancestorThreadId).map(item => item.params.isPinned)).toEqual([true, false]);
      expect(history.data.map(item => item.id)).toEqual(["game4-thread"]);
    } finally { service.close("run-1"); }
  });

  it("organizes Codex threads through App Server and keeps an archived current thread read-only", async () => {
    const received = [];
    let failArchive = true;
    const child = fakeProcess(received, request => {
      if (request.method === "thread/read") return { thread: { id: request.params.threadId,
        cwd: request.params.threadId === "other-project" ? "C:\\other" : "C:\\project" } };
      if (request.method === "thread/metadata/update") return { thread: { id: request.params.threadId, isPinned: request.params.isPinned } };
      if (request.method === "thread/fork") return { thread: { id: "branch-1", forkedFromId: request.params.threadId } };
      if (request.method === "thread/resume") return { thread: { id: request.params.threadId, turns: [] } };
      if (request.method === "thread/archive" && failArchive) return { __error: "归档失败" };
      if (request.method === "thread/list") return { data: request.params.isPinned
        ? [{ id: "branch-1", name: "分支", isPinned: true, updatedAt: 123 }] : [], nextCursor: null };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await expect(service.renameThread("run-1", "other-project", "错误目标")).rejects.toThrow("当前项目");
      expect(received.some(item => item.method === "thread/name/set")).toBe(false);
      await service.renameThread("run-1", "thread-1", " 新名称 ");
      expect(await service.pinThread("run-1", "thread-1", true)).toEqual({ isPinned: true });
      expect(received.find(item => item.method === "thread/name/set").params).toEqual({ threadId: "thread-1", name: "新名称" });
      expect(received.find(item => item.method === "thread/metadata/update").params).toEqual({ threadId: "thread-1", isPinned: true });
      expect((await service.listHistory("run-1", null, true)).data[0]).toMatchObject({ archived: true, isPinned: true });
      expect(received.find(item => item.method === "thread/list" && !item.params.ancestorThreadId).params.archived).toBe(true);
      expect((await service.forkThread("run-1", "thread-1")).threadId).toBe("branch-1");
      expect(received.find(item => item.method === "thread/fork").params).toEqual({ threadId: "thread-1", approvalPolicy: "on-request", sandbox: "workspace-write" });
      await expect(service.archiveThread("run-1", "branch-1")).rejects.toThrow("归档失败");
      expect(service.snapshot("run-1").archived).toBe(false);
      failArchive = false;
      await service.archiveThread("run-1", "branch-1");
      expect(service.snapshot("run-1").archived).toBe(true);
      await expect(service.submit("run-1", "继续")).rejects.toThrow("未就绪");
      await service.unarchiveThread("run-1", "branch-1");
      expect(service.snapshot("run-1").archived).toBe(false);
      expect(received.some(item => item.method === "thread/unarchive")).toBe(true);
      expect(received.filter(item => item.method === "thread/resume" && item.params.threadId === "branch-1")).toHaveLength(2);
    } finally { service.close("run-1"); }
  });
  it("reads plugin and App details and only reads a listed MCP resource", async () => {
    const received = [];
    const child = fakeProcess(received, request => {
      if (request.method === "plugin/list") return { marketplaces: [{ name: "official", path: null,
        plugins: [{ id: "design@official", name: "design", installed: true, enabled: true,
          source: { type: "remote" }, interface: { shortDescription: "Design tools" } }] }] };
      if (request.method === "plugin/read") return { plugin: { marketplaceName: "official", summary: {
        name: "design", remotePluginId: "remote-1", source: { type: "remote" }, installed: true, enabled: true,
        version: "1.2.0" }, description: "Design tools", skills: [{ name: "draw", description: "Draw", enabled: true }],
        apps: [{ id: "app-1", name: "Design App" }], mcpServers: ["files"] } };
      if (request.method === "plugin/skill/read") return { contents: "# Draw" };
      if (request.method === "app/installed") return { apps: [{ id: "app-1", enabled: true, callable: true }] };
      if (request.method === "app/list") return { data: [{ id: "app-1", name: "Design App", description: "Create designs", isAccessible: true, isEnabled: true }] };
      if (request.method === "app/read") return { apps: [{ id: "app-1", name: "Design App", description: "Create designs",
        toolSummaries: [{ name: "draw", title: "Draw", description: "Draw shapes", isEnabled: true, isReadOnly: false }] }] };
      if (request.method === "mcpServerStatus/list") return { data: [{ name: "files", runtimeStatus: "connected", authStatus: "unsupported",
        tools: { read: { name: "read", description: "Read" } }, resources: [{ uri: "file:///a", name: "A" }],
        resourceTemplates: [{ uriTemplate: "file:///{name}", name: "Files" }] }] };
      if (request.method === "mcpServer/resource/read") return { contents: [{ uri: "file:///a", text: "hello" }] };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", agentProvider: "codex", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      expect(await service.readPluginDetail("run-1", "design", "official")).toMatchObject({ version: "1.2.0", skills: [{ name: "draw" }] });
      expect(received.find(item => item.method === "plugin/read").params).toEqual({ pluginName: "design", remoteMarketplaceName: "official" });
      expect(await service.readPluginSkill("run-1", "design", "official", "draw")).toEqual({ contents: "# Draw", truncated: false });
      expect(await service.readAppDetail("run-1", "app-1")).toMatchObject({ callable: true, tools: [{ name: "draw" }] });
      expect(received.find(item => item.method === "app/read").params).toEqual({ appIds: ["app-1"], threadId: "thread-1", includeTools: true });
      expect(await service.readMcpResource("run-1", "files", "file:///a")).toEqual({ contents: [{ uri: "file:///a", mimeType: null, text: "hello", binary: false, truncated: false }], truncated: false });
      expect(received.find(item => item.method === "mcpServerStatus/list").params.detail).toBe("full");
      await expect(service.readMcpResource("run-1", "files", "file:///other")).rejects.toThrow("不在当前会话目录");
      expect(received.filter(item => item.method === "mcpServer/resource/read")).toHaveLength(1);
    } finally { service.close("run-1"); }
  });

  it("forks through a selected finished turn and rejects unknown or running turns", async () => {
    const received = [];
    const child = fakeProcess(received, request => {
      if (request.method === "thread/read") return { thread: { id: request.params.threadId, cwd: "C:\\project",
        turns: request.params.includeTurns ? [{ id: "turn-1", status: "completed" }, { id: "turn-2", status: "inProgress" }] : undefined } };
      if (request.method === "thread/fork") return { thread: { id: "branch-1" } };
      if (request.method === "thread/resume") return { thread: { id: request.params.threadId, turns: [] } };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await expect(service.forkThread("run-1", "thread-1", "missing")).rejects.toThrow("所选回合");
      await expect(service.forkThread("run-1", "thread-1", "turn-2")).rejects.toThrow("所选回合");
      expect(received.some(item => item.method === "thread/fork")).toBe(false);
      expect((await service.forkThread("run-1", "thread-1", "turn-1")).threadId).toBe("branch-1");
      expect(received.find(item => item.method === "thread/fork").params).toEqual({ threadId: "thread-1", lastTurnId: "turn-1", approvalPolicy: "on-request", sandbox: "workspace-write" });
      expect(received.some(item => item.method === "thread/read" && item.params.includeTurns === true)).toBe(true);
    } finally { service.close("run-1"); }
  });

  it("rejects pin updates that the App Server does not confirm", async () => {
    let metadata = { thread: { id: "other-thread", isPinned: true } };
    const child = fakeProcess([], request => {
      if (request.method === "thread/read") return { thread: { id: request.params.threadId, cwd: "C:\\project" } };
      if (request.method === "thread/metadata/update") return metadata;
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await expect(service.pinThread("run-1", "thread-1", true)).rejects.toThrow("未确认会话置顶状态");
      metadata = { thread: { id: "thread-1", isPinned: false } };
      await expect(service.pinThread("run-1", "thread-1", true)).rejects.toThrow("未确认会话置顶状态");
    } finally { service.close("run-1"); }
  });

  it("streams plan text, updates plan steps, and keeps the completed plan", async () => {
    const child = fakeProcess([]);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1", item: { id: "plan-1", type: "plan", text: "" } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "item/plan/delta", params: { threadId: "thread-1", itemId: "plan-1", delta: "# 初稿" } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", explanation: null,
      plan: [{ step: "检查代码", status: "inProgress" }] } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").items.find(item => item.id === "plan-1")?.text).toBe("# 初稿"));
    expect(service.snapshot("run-1").items.find(item => item.type === "turnPlan")?.plan).toEqual([{ step: "检查代码", status: "inProgress" }]);
    child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1", item: { id: "plan-1", type: "plan", text: "# 正式计划" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").items.find(item => item.id === "plan-1")?.text).toBe("# 正式计划"));
    service.close("run-1");
  });

  it("offers a completed plan once and executes it in the same thread with Exec mode", async () => {
    const received = [];
    const child = fakeProcess(received);
    const statuses = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: value => statuses.push(value) }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    service.setMode("run-1", "plan");
    await service.submit("run-1", "制定计划");
    child.stdout.write(`${JSON.stringify({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1",
      plan: [{ step: "检查代码", status: "completed" }] } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1",
      item: { id: "plan-1", type: "agentMessage", text: "<proposed_plan>\n# 正式计划\n</proposed_plan>" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").items.some(item => item.id === "plan-1")).toBe(true));
    expect(service.snapshot("run-1").pendingPlan).toBeNull();
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").pendingPlan).toEqual({ itemId: "plan-1" }));
    expect(statuses.at(-1)).toMatchObject({ status: "completed", eventName: "AppServerPlanPending" });
    await service.executePlan("run-1", "plan-1");
    expect(statuses.at(-1)).toMatchObject({ status: "running", eventName: "AppServerTurn" });
    const turns = received.filter(item => item.method === "turn/start");
    expect(turns).toHaveLength(2);
    expect(turns[1].params).toMatchObject({ threadId: "thread-1", collaborationMode: { mode: "default" },
      sandboxPolicy: { type: "workspaceWrite" } });
    expect(turns[1].params.input).toEqual([{ type: "text", text: "按上述计划执行。" }]);
    expect(service.snapshot("run-1").pendingPlan).toBeNull();
    await expect(service.executePlan("run-1", "plan-1")).rejects.toThrow();
    service.close("run-1");
  });

  it("does not offer failed or progress-only plans and can dismiss a completed plan", async () => {
    const child = fakeProcess([]);
    const statuses = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: value => statuses.push(value) }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    service.setMode("run-1", "plan");
    await service.submit("run-1", "制定计划");
    child.stdout.write(`${JSON.stringify({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1",
      plan: [{ step: "检查代码", status: "pending" }] } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").busy).toBe(false));
    expect(service.snapshot("run-1").pendingPlan).toBeNull();
    await service.submit("run-1", "再试一次");
    child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1",
      item: { id: "plan-2", type: "plan", text: "# 正式计划" } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "failed" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").busy).toBe(false));
    expect(service.snapshot("run-1").pendingPlan).toBeNull();
    await service.submit("run-1", "继续");
    child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1",
      item: { id: "plan-3", type: "plan", text: "# 新计划" } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").pendingPlan).toEqual({ itemId: "plan-3" }));
    expect(statuses.at(-1).eventName).toBe("AppServerPlanPending");
    service.dismissPlan("run-1", "plan-3");
    expect(service.snapshot("run-1").pendingPlan).toBeNull();
    expect(statuses.at(-1)).toMatchObject({ status: "completed", eventName: "AppServerTurn" });
    await expect(service.executePlan("run-1", "plan-3")).rejects.toThrow("失效");
    await service.submit("run-1", "更新计划");
    child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1",
      item: { id: "plan-4", type: "plan", text: "# 更新计划" } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
    await vi.waitFor(() => expect(service.snapshot("run-1").pendingPlan).toEqual({ itemId: "plan-4" }));
    service.setMode("run-1", "default");
    expect(service.snapshot("run-1").pendingPlan).toBeNull();
    expect(statuses.at(-1)).toMatchObject({ status: "completed", eventName: "AppServerTurn" });
    service.close("run-1");
  });

  it("sends Plan mode and selected image plus file path, while rejecting unselected files", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-codex-attachments-"));
    const imagePath = path.join(directory, "image.png");
    const documentPath = path.join(directory, "notes.txt");
    fs.writeFileSync(imagePath, "image"); fs.writeFileSync(documentPath, "notes");
    const received = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      service.setMode("run-1", "plan");
      await expect(service.submit("run-1", "检查", [documentPath])).rejects.toThrow("文件选择器");
      service.allowFiles("run-1", [imagePath, documentPath]);
      await service.submit("run-1", "检查", [imagePath, documentPath]);
      const turn = received.find(item => item.method === "turn/start");
      expect(turn.params.collaborationMode.mode).toBe("plan");
      expect(turn.params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
      expect(turn.params.input).toEqual([{ type: "text", text: `检查\n\n请读取以下附件文件：${JSON.stringify(documentPath)}` },
        { type: "localImage", path: imagePath }]);
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").busy).toBe(false));
      service.setMode("run-1", "default");
      await service.submit("run-1", "继续");
      expect(received.filter(item => item.method === "turn/start").at(-1).params.sandboxPolicy).toMatchObject({ type: "workspaceWrite" });
      service.close("run-1");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("applies execution permissions per turn and retains the choice within one session", async () => {
    const received = [];
    const child = fakeProcess(received, request => {
      if (request.method === "thread/read") return { thread: { cwd: "C:\\project" } };
      if (request.method === "thread/resume") return { thread: { id: "history-1", turns: [] } };
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    const finishTurn = async threadId => {
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId,
        turn: { status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").busy).toBe(false));
    };
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    try {
      expect(service.snapshot("run-1").executionPermission).toBe("askApproval");
      await expect(service.setExecutionPermission("run-1", "invalid")).rejects.toThrow("无效");
      await service.setExecutionPermission("run-1", "readOnly");
      await service.submit("run-1", "检查");
      expect(received.filter(item => item.method === "turn/start").at(-1).params).toMatchObject({
        approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }
      });
      await expect(service.setExecutionPermission("run-1", "fullAccess")).rejects.toThrow("不可切换");
      await finishTurn("thread-1");

      await service.setExecutionPermission("run-1", "fullAccess");
      service.setMode("run-1", "plan");
      await service.submit("run-1", "制定计划");
      expect(received.filter(item => item.method === "turn/start").at(-1).params).toMatchObject({
        approvalPolicy: "never", sandboxPolicy: { type: "readOnly" }
      });
      child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1",
        item: { id: "plan-permission", type: "plan", text: "# 计划" } } })}\n`);
      await finishTurn("thread-1");
      expect(service.snapshot("run-1").pendingPlan).toEqual({ itemId: "plan-permission" });
      await service.executePlan("run-1", "plan-permission");
      expect(received.filter(item => item.method === "turn/start").at(-1).params).toMatchObject({
        approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }
      });
      await finishTurn("thread-1");

      await service.newThread("run-1");
      expect(service.snapshot("run-1").executionPermission).toBe("fullAccess");
      await service.resume("run-1", "history-1");
      expect(service.snapshot("run-1").executionPermission).toBe("fullAccess");
      await service.setExecutionPermission("run-1", "askApproval");
      await service.submit("run-1", "继续");
      expect(received.filter(item => item.method === "turn/start").at(-1).params).toMatchObject({
        approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: ["C:\\project"], networkAccess: false }
      });
    } finally { service.close("run-1"); }
  });

  it("syncs a template permission to other instances for their next turn", async () => {
    const received = [];
    const children = [fakeProcess(received), fakeProcess(received), fakeProcess(received), fakeProcess(received), fakeProcess(received)];
    let nextChild = 0;
    const template = { id: "template-1", codexExecutionPermission: "readOnly" };
    const sessionStore = { getTemplate: vi.fn(id => id === template.id ? template : undefined),
      setCodexExecutionPermission: vi.fn((_id, permission) => { template.codexExecutionPermission = permission; }) };
    const changed = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: (event, value) => {
        if (event === "codex-app-server:changed") changed.push(value);
      }, sessionStore, spawnProcess: () => children[nextChild++] });
    const session = (id, templateId) => ({ id, templateId, type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    try {
      await service.start(session("run-1", template.id));
      await service.start(session("run-2", template.id));
      await service.start(session("other", "template-2"));
      await service.start(session("temporary"));
      expect(service.snapshot("run-1").executionPermission).toBe("readOnly");
      await service.submit("run-2", "正在执行");
      const runningTurn = received.filter(item => item.method === "turn/start").at(-1);
      expect(runningTurn.params.sandboxPolicy.type).toBe("readOnly");
      await service.setExecutionPermission("run-1", "fullAccess");
      expect(sessionStore.setCodexExecutionPermission).toHaveBeenCalledWith(template.id, "fullAccess");
      expect(service.snapshot("run-2").executionPermission).toBe("fullAccess");
      expect(service.snapshot("other").executionPermission).toBe("askApproval");
      expect(changed.some(value => value.id === "run-2" && value.snapshot.executionPermission === "fullAccess")).toBe(true);
      await service.start(session("run-3", template.id));
      expect(service.snapshot("run-3").executionPermission).toBe("fullAccess");
      expect(service.snapshot("run-2").busy).toBe(true);
      children[1].stdout.write(`${JSON.stringify({ method: "turn/completed", params: {
        threadId: "thread-1", turn: { status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-2").busy).toBe(false));
      await service.submit("run-2", "下一轮");
      expect(received.filter(item => item.method === "turn/start").at(-1).params.sandboxPolicy.type).toBe("dangerFullAccess");
      await service.setExecutionPermission("temporary", "readOnly");
      expect(sessionStore.setCodexExecutionPermission).toHaveBeenCalledTimes(1);
      expect(service.snapshot("temporary").executionPermission).toBe("readOnly");
      sessionStore.setCodexExecutionPermission.mockImplementation(() => { throw new Error("disk full"); });
      await expect(service.setExecutionPermission("run-1", "askApproval")).rejects.toThrow("disk full");
      expect(service.snapshot("run-1").executionPermission).toBe("fullAccess");
      expect(service.snapshot("run-2").executionPermission).toBe("fullAccess");
    } finally {
      for (const id of ["run-1", "run-2", "other", "temporary", "run-3"]) service.close(id);
    }
  });

  it("converts selected Windows paths for WSL and fails before starting a turn when inaccessible", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-codex-wsl-"));
    const filePath = path.join(directory, "notes.txt");
    fs.writeFileSync(filePath, "notes");
    const received = [];
    const convert = vi.fn(() => ({ status: 1, stdout: "" }));
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => fakeProcess(received),
      spawnSyncProcess: convert });
    try {
      await service.start({ id: "run-1", type: "wsl", wslDistro: "Ubuntu", shell: "bash", cwd: "/repo" });
      service.allowFiles("run-1", [filePath]);
      await expect(service.submit("run-1", "检查", [filePath])).rejects.toThrow("WSL 无法访问文件");
      expect(received.some(item => item.method === "turn/start")).toBe(false);
      expect(convert).toHaveBeenCalledWith("wsl.exe", ["-d", "Ubuntu", "--", "wslpath", "-a", "-u", filePath], expect.any(Object));
      convert.mockReturnValueOnce({ status: 0, stdout: "/mnt/c/files/notes.txt\n" }).mockReturnValueOnce({ status: 0 });
      await service.submit("run-1", "检查", [filePath]);
      expect(received.find(item => item.method === "turn/start").params.input[0].text).toContain('"/mnt/c/files/notes.txt"');
      service.allowFiles("run-1", [filePath]);
      convert.mockReturnValueOnce({ status: 0, stdout: "/mnt/c/files/notes.txt\n" }).mockReturnValueOnce({ status: 0 });
      await service.submit("run-1", "补充检查", [filePath]);
      expect(received.find(item => item.method === "turn/steer").params.input[0].text)
        .toContain('"/mnt/c/files/notes.txt"');
      service.close("run-1");
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("uses trusted WSL clipboard images directly and retains them after sending", async () => {
    const received = [];
    const removed = [];
    const child = fakeProcess(received);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child,
      removePastedImage: async (_entry, filePath) => { removed.push(filePath); } });
    await service.start({ id: "run-1", type: "wsl", wslDistro: "Ubuntu", shell: "bash", cwd: "/repo" });
    const discarded = "/repo/.pannel-handle-images/discard.png";
    service.allowPastedImage("run-1", discarded);
    await service.discardPastedImage("run-1", discarded);
    expect(removed).toEqual([discarded]);
    const sent = "/repo/.pannel-handle-images/sent.png";
    service.allowPastedImage("run-1", sent);
    await service.submit("run-1", "检查图片", [sent]);
    expect(received.find(item => item.method === "turn/start").params.input).toEqual([
      { type: "text", text: "检查图片" }, { type: "localImage", path: sent }
    ]);
    service.close("run-1");
    expect(removed).toEqual([discarded]);
  });

  it("removes unsent pasted images on a new thread and session close", async () => {
    const removed = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {},
      spawnProcess: () => fakeProcess([]), removePastedImage: async (_entry, filePath) => { removed.push(filePath); } });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    const oldThreadImage = "C:\\project\\.pannel-handle-images\\old-thread.png";
    service.allowPastedImage("run-1", oldThreadImage);
    await service.newThread("run-1");
    expect(removed).toEqual([oldThreadImage]);
    const pending = "C:\\project\\.pannel-handle-images\\pending.png";
    service.allowPastedImage("run-1", pending);
    service.close("run-1");
    await vi.waitFor(() => expect(removed).toEqual([oldThreadImage, pending]));
  });

  it("broadcasts live activity summaries without command output and keeps the final answer", async () => {
    const child = fakeProcess([]);
    const statuses = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: value => statuses.push(value) }, broadcast: () => {}, spawnProcess: () => child });
    await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    await service.submit("run-1", "检查构建");
    expect(statuses.at(-1)).toMatchObject({ id: "run-1", status: "running", activitySummary: "检查构建" });
    const emit = (method, params) => child.stdout.write(`${JSON.stringify({ method, params: { threadId: "thread-1", ...params } })}\n`);
    emit("turn/plan/updated", { turnId: "turn-1", plan: [{ step: "检查依赖", status: "inProgress" }] });
    await vi.waitFor(() => expect(statuses.some(value => value.activitySummary === "检查依赖")).toBe(true));
    emit("item/started", { item: { id: "command-1", type: "commandExecution", command: "pnpm build" } });
    await vi.waitFor(() => expect(statuses.some(value => value.activitySummary === "执行命令：pnpm build")).toBe(true));
    child.stdout.write(`${JSON.stringify({ id: 42, method: "item/commandExecution/requestApproval",
      params: { threadId: "thread-1", reason: "等待构建命令确认" } })}\n`);
    await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ status: "waiting_for_permission", activitySummary: "等待构建命令确认" }));
    service.resolveApproval("run-1", 42, true);
    expect(statuses.at(-1)).toMatchObject({ status: "running" });
    emit("item/commandExecution/outputDelta", { itemId: "command-1", delta: "private output" });
    emit("item/completed", { item: { id: "command-1", type: "commandExecution", command: "pnpm build", status: "completed" } });
    await vi.waitFor(() => expect(service.snapshot("run-1").items.find(item => item.id === "command-1")?.output).toBe("private output"));
    emit("item/started", { item: { id: "answer-1", type: "agentMessage", text: "" } });
    emit("item/agentMessage/delta", { itemId: "answer-1", delta: "构建" });
    emit("item/agentMessage/delta", { itemId: "answer-1", delta: "通过" });
    await vi.waitFor(() => expect(statuses.some(value => value.activitySummary === "构建通过")).toBe(true));
    expect(statuses.some(value => value.activitySummary?.includes("private output"))).toBe(false);
    emit("turn/completed", { turn: { status: "completed" } });
    await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ status: "completed", activitySummary: "构建通过" }));
    service.close("run-1");
  });

  it("retains turn IDs for live items and restored history", async () => {
    const child = fakeProcess([], request => request.method === "thread/read" ? { thread: { cwd: "C:\\project" } }
      : request.method === "thread/resume" ? { thread: { id: "history-1", turns: [
        { id: "history-turn-1", items: [{ id: "history-command", type: "commandExecution", command: "pwd" }] },
        { id: "history-turn-2", items: [{ id: "history-answer", type: "agentMessage", text: "完成" }] }
      ] } } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      await service.submit("run-1", "检查项目");
      child.stdout.write(`${JSON.stringify({ method: "item/started", params: { threadId: "thread-1",
        item: { id: "live-command", type: "commandExecution", command: "pwd" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").items.find(item => item.id === "live-command")?.turnId).toBe("turn-1"));
      child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { threadId: "thread-1",
        item: { id: "live-command", type: "commandExecution", command: "pwd", status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").items.find(item => item.id === "live-command")).toMatchObject({ turnId: "turn-1", status: "completed" }));
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("run-1").busy).toBe(false));
      await service.resume("run-1", "history-1");
      expect(service.snapshot("run-1").items.map(item => item.turnId)).toEqual(["history-turn-1", "history-turn-2"]);
    } finally { service.close("run-1"); }
  });

  it("restores and clears summaries for one instance without changing another", async () => {
    const children = [fakeProcess([], request => request.method === "thread/read" ? { thread: { cwd: "C:\\project" } }
      : request.method === "thread/resume" ? { thread: { id: "history-1", turns: [{ items: [
        { id: "answer-1", type: "agentMessage", text: "历史结论" }
      ] }] } } : undefined), fakeProcess([])];
    const statuses = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: value => statuses.push(value) }, broadcast: () => {},
      spawnProcess: () => children.shift() });
    const session = { type: "windows", shell: "cmd.exe", cwd: "C:\\project" };
    await service.start({ ...session, id: "run-1" });
    await service.start({ ...session, id: "run-2" });
    await service.submit("run-2", "另一个任务");
    await service.resume("run-1", "history-1");
    expect(statuses.at(-1)).toMatchObject({ id: "run-1", activitySummary: "历史结论" });
    await service.newThread("run-1");
    expect(statuses.at(-1)).toMatchObject({ id: "run-1", status: "cleared", activitySummary: undefined });
    expect(statuses.filter(value => value.id === "run-2").at(-1).activitySummary).toBe("另一个任务");
    service.close("run-1"); service.close("run-2");
  });
  it("runs remote App Server over SSH and keeps uploaded attachments available in history", async () => {
    const received = [];
    let remotePath;
    const child = fakeProcess(received, request => request.method === "thread/read"
      ? { thread: { cwd: "/srv/app" } }
      : request.method === "thread/resume" ? { thread: { id: "history-1", turns: [{ items: [{ id: "history-user", type: "userMessage",
        content: [{ type: "text", text: `检查\n\n请读取以下附件文件：${JSON.stringify(remotePath)}` }] }] }] } }
        : undefined);
    const transport = new EventEmitter();
    transport.write = data => child.stdin.write(data);
    transport.close = vi.fn(() => transport.emit("close", 0));
    child.stdout.on("data", data => transport.emit("stdout", data));
    const sshAgentTransport = { createStdioTransport: vi.fn(async () => transport) };
    const stored = new Map();
    const sshFileSystem = { cwd: vi.fn(async () => "/home/user"), mkdir: vi.fn(async () => {}), chmod: vi.fn(async () => {}),
      fastPut: vi.fn(async (_id, source, target) => { stored.set(target, fs.readFileSync(source)); }),
      stat: vi.fn(async (_id, target) => ({ size: stored.get(target).length, isFile: () => true })),
      get: vi.fn(async (_id, target) => stored.get(target)),
      remove: vi.fn(async (_id, target) => { stored.delete(target); }) };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-remote-app-server-"));
    const localPath = path.join(directory, "notes.txt");
    fs.writeFileSync(localPath, "remote notes");
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({ FLAG: "enabled" }) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, sshAgentTransport, sshFileSystem });
    try {
      await service.start({ id: "ssh-1", type: "ssh", cwd: "/srv/app", initialCommand: "echo ready" });
      expect(sshAgentTransport.createStdioTransport).toHaveBeenCalledWith("ssh-1", expect.objectContaining({
        command: expect.stringContaining("codex app-server --stdio") }));
      expect(sshAgentTransport.createStdioTransport.mock.calls[0][1].command).toContain("export FLAG");
      service.allowFiles("ssh-1", [localPath]);
      await service.submit("ssh-1", "检查", [localPath]);
      remotePath = service.snapshot("ssh-1").items[0].attachments[0].path;
      expect(remotePath).toMatch(/^\/home\/user\/\.cache\/pannel-handle\/app-server\//);
      expect(received.find(item => item.method === "turn/start").params.input[0].text).toContain(remotePath);
      expect(await service.previewAttachment("ssh-1", remotePath)).toEqual({ kind: "text", text: "remote notes" });
      child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })}\n`);
      await vi.waitFor(() => expect(service.snapshot("ssh-1").busy).toBe(false));
      await service.resume("ssh-1", "history-1");
      expect(service.snapshot("ssh-1").items[0].attachments[0].path).toBe(remotePath);
      expect(await service.previewAttachment("ssh-1", remotePath)).toEqual({ kind: "text", text: "remote notes" });
      const pastedPath = "/srv/app/.pannel-handle-images/pasted.png";
      stored.set(pastedPath, Buffer.from([137, 80, 78, 71]));
      service.allowPastedImage("ssh-1", pastedPath);
      expect((await service.previewAttachment("ssh-1", pastedPath)).kind).toBe("image");
      await service.discardPastedImage("ssh-1", pastedPath);
      expect(stored.has(pastedPath)).toBe(false);
      service.close("ssh-1");
      expect(stored.has(remotePath)).toBe(true);
    } finally { service.close("ssh-1"); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("removes partially uploaded remote files when an upload fails", async () => {
    const child = fakeProcess([]);
    const transport = new EventEmitter();
    transport.write = data => child.stdin.write(data);
    transport.close = () => transport.emit("close", 0);
    child.stdout.on("data", data => transport.emit("stdout", data));
    const uploaded = [];
    const sshFileSystem = { cwd: async () => "/home/user", mkdir: async () => {}, chmod: async () => {},
      fastPut: vi.fn(async (_id, _source, target) => { uploaded.push(target); throw new Error("disk full"); }),
      remove: vi.fn(async () => {}) };
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pannel-remote-failed-upload-"));
    const localPath = path.join(directory, "notes.txt");
    fs.writeFileSync(localPath, "notes");
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {},
      sshAgentTransport: { createStdioTransport: async () => transport }, sshFileSystem });
    try {
      await service.start({ id: "ssh-1", type: "ssh", cwd: "/srv/app" });
      service.allowFiles("ssh-1", [localPath]);
      await expect(service.submit("ssh-1", "检查", [localPath])).rejects.toThrow("disk full");
      expect(sshFileSystem.remove).toHaveBeenCalledWith("ssh-1", uploaded[0]);
      expect(service.snapshot("ssh-1").busy).toBe(false);
    } finally { service.close("ssh-1"); fs.rmSync(directory, { recursive: true, force: true }); }
  });
  it("reconnects a remote App Server session and resumes its thread", async () => {
    const received = [];
    const transports = [0, 1].map(() => {
      const child = fakeProcess(received, request => request.method === "thread/resume"
        ? { thread: { id: "thread-1", model: "test-model", turns: [{ items: [
          { id: "previous", type: "agentMessage", text: "之前的回复" }
        ] }] } } : undefined);
      const transport = new EventEmitter();
      transport.write = data => child.stdin.write(data);
      transport.close = () => transport.emit("close", 0);
      child.stdout.on("data", data => transport.emit("stdout", data));
      return transport;
    });
    const session = { id: "ssh-1", type: "ssh", cwd: "/srv/app" };
    const terminalManager = { getSession: () => session, listSessions: () => [session],
      setAppServerConnectionState: vi.fn(), broadcastAgentStatus: () => {} };
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager, broadcast: () => {},
      sshAgentTransport: { createStdioTransport: vi.fn(async () => transports.shift()) } });
    try {
      await service.start(session);
      await expect(service.restart("ssh-1")).resolves.toEqual(session);
      expect(received.some(item => item.method === "thread/resume" && item.params.threadId === "thread-1")).toBe(true);
      expect(service.snapshot("ssh-1").items[0].text).toBe("之前的回复");
      expect(terminalManager.setAppServerConnectionState.mock.calls.map(call => call[1])).toEqual([
        "connected", "reconnecting", "connected"
      ]);
    } finally { service.close("ssh-1"); }
  });
});


describe("Codex sub-agent observation integration", () => {
  it("routes child notifications before root filtering and resets observers on thread switches", async () => {
    const received = [];
    const child = fakeProcess(received, message => {
      if (message.method === "thread/list") return { data: [], nextCursor: null };
      if (message.method === "thread/read") return { thread: { id: message.params.threadId, cwd: "C:\\project", turns: [] } };
      return undefined;
    });
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    const emit = (method, params) => child.stdout.write(`${JSON.stringify({ method, params })}\n`);
    try {
      await service.start({ id: "run-1", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      emit("item/completed", { threadId: "thread-1", item: { id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["child"], agentsStates: {}, prompt: "inspect" } });
      emit("item/started", { threadId: "child", turnId: "child-turn", item: { id: "answer", type: "agentMessage", text: "" } });
      emit("item/agentMessage/delta", { threadId: "child", itemId: "answer", delta: "child reply" });
      await vi.waitFor(() => expect(service.snapshot("run-1").subAgents.members[0].items[0].text).toBe("child reply"));
      expect(service.snapshot("run-1").items.some(item => item.id === "answer")).toBe(false);
      expect(() => service.setSubAgentView("run-1", false, undefined, "old-root")).toThrow("已切换");
      await expect(service.refreshSubAgents("run-1", "old-root")).rejects.toThrow("已切换");
      service.setSubAgentView("run-1", false);
      expect(service.snapshot("run-1").subAgents.expanded).toBe(false);
      await service.newThread("run-1");
      expect(service.snapshot("run-1").subAgents.members).toEqual([]);
      expect(received.filter(message => message.method === "thread/resume")).toEqual([]);
    } finally { service.shutdown(); }
  });
});


describe("configuration and named permissions", () => {
  function fixture({ profile = null, denied = false, settingsError = false } = {}) {
    const received = [];
    const template = { id: "template", codexExecutionPermission: "askApproval", codexPermissionProfileId: profile };
    const store = { getTemplate: () => template,
      setCodexPermissionProfile: vi.fn((_id, value) => { template.codexPermissionProfileId = value; }),
      setCodexExecutionPermission: vi.fn((_id, value) => { template.codexExecutionPermission = value; template.codexPermissionProfileId = undefined; }) };
    const children = [];
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      sessionStore: store, terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {},
      spawnProcess: () => {
        const child = fakeProcess(received, request => {
          if (request.method === "configRequirements/read") return { requirements: null };
          if (request.method === "permissionProfile/list") return { data: [{ id: "project", allowed: !denied }] };
          if (request.method === "config/read") return { config: { model: "test-model", api_key: "secret" }, layers: [] };
          if (request.method === "thread/settings/update" && settingsError) return { __error: "denied" };
          if (request.method === "thread/read") return { thread: { id: request.params.threadId, cwd: "C:\\project" } };
          if (request.method === "thread/fork") return { thread: { id: "forked" } };
          if (request.method === "thread/resume") return { thread: { id: request.params.threadId, turns: [] } };
        });
        children.push(child); return child;
      } });
    const start = id => service.start({ id, templateId: template.id, agentProvider: "codex", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
    const finish = (index = 0) => children[index].stdout.write(`${JSON.stringify({ method: "turn/completed", params: { threadId: service.snapshot(index ? "other" : "run").threadId, turn: { status: "completed" } } })}\n`);
    return { service, received, start, store, finish, children };
  }
  it("applies and saves profiles after success without changing other running instances", async () => {
    const f = fixture();
    try {
      await f.start("run"); await f.start("other");
      await f.service.setPermissionProfile("run", "project");
      expect(f.store.setCodexPermissionProfile).toHaveBeenCalledWith("template", "project");
      expect(f.service.snapshot("other").permissionProfileId).toBeNull();
      expect(f.received.find(v => v.method === "thread/settings/update").params).toEqual({ threadId: "thread-1", permissions: "project" });
      await f.service.submit("run", "work");
      const turn = f.received.filter(v => v.method === "turn/start").at(-1).params;
      expect(turn.permissions).toBe("project"); expect(turn).not.toHaveProperty("sandboxPolicy"); expect(turn).not.toHaveProperty("approvalPolicy");
      f.finish();
      await f.service.newThread("run");
      expect(f.received.filter(v => v.method === "thread/start").at(-1).params).toMatchObject({ permissions: "project" });
      await f.service.forkThread("run", "thread-1");
      expect(f.received.filter(v => v.method === "thread/fork").at(-1).params).toMatchObject({ permissions: "project" });
      expect(f.received.filter(v => v.method === "thread/resume").at(-1).params).toMatchObject({ permissions: "project" });
      await f.start("future");
      expect(f.service.snapshot("future").permissionProfileId).toBe("project");
    } finally { f.service.shutdown(); }
  });
  it("uses read-only for Plan and restores the profile for the next default turn", async () => {
    const f = fixture({ profile: "project" });
    try {
      await f.start("run"); f.service.setMode("run", "plan");
      await f.service.submit("run", "plan");
      expect(f.received.filter(v => v.method === "turn/start").at(-1).params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
      expect(f.received.filter(v => v.method === "turn/start").at(-1).params).not.toHaveProperty("permissions");
      f.finish(); f.service.setMode("run", "default");
      await f.service.submit("run", "implement");
      expect(f.received.filter(v => v.method === "turn/start").at(-1).params.permissions).toBe("project");
    } finally { f.service.shutdown(); }
  });
  it("keeps invalid saved profiles blocked and allows explicit legacy recovery", async () => {
    const f = fixture({ profile: "missing" });
    try {
      expect((await f.start("run")).permissionError).toContain("不存在");
      expect(f.received.some(v => v.method === "thread/start")).toBe(false);
      const view = await f.service.readConfiguration("run");
      expect(JSON.stringify(view)).not.toContain("secret");
      expect(view.runtime.permissionProfileId).toBe("missing");
      expect((await f.service.setExecutionPermission("run", "readOnly")).threadId).toBe("thread-1");
      expect(f.service.snapshot("run").permissionProfileId).toBeNull();
      expect(f.store.setCodexExecutionPermission).toHaveBeenCalledWith("template", "readOnly");
    } finally { f.service.shutdown(); }
  });
  it("does not save denied profiles or server-rejected settings", async () => {
    for (const options of [{ denied: true }, { settingsError: true }]) {
      const f = fixture(options);
      try {
        await f.start("run");
        await expect(f.service.setPermissionProfile("run", "project")).rejects.toThrow();
        expect(f.store.setCodexPermissionProfile).not.toHaveBeenCalled();
        expect(f.service.snapshot("run")).toMatchObject({ permissionProfileId: null, changingPermission: false });
      } finally { f.service.shutdown(); }
    }
  });
  it("restores runtime selection when saving the template fails", async () => {
    const f = fixture();
    try {
      await f.start("run");
      f.store.setCodexPermissionProfile.mockImplementation(() => { throw new Error("disk full"); });
      await expect(f.service.setPermissionProfile("run", "project")).rejects.toThrow("disk full");
      expect(f.service.snapshot("run")).toMatchObject({ permissionProfileId: null, executionPermission: "askApproval" });
      expect(f.received.filter(v => v.method === "thread/settings/update").at(-1).params.sandboxPolicy.type).toBe("workspaceWrite");
    } finally { f.service.shutdown(); }
  });
});


describe("Codex image input capabilities", () => {
  it.each([["text"], ["text", "image"], undefined, [], [null]])("checks images before mutating the turn for modalities %j", async modalities => {
    const received = [];
    const child = fakeProcess(received, request => request.method === "model/list"
      ? { data: [{ id: "test-model", isDefault: true, inputModalities: modalities }] } : undefined);
    const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
      terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {}, spawnProcess: () => child });
    try {
      await service.start({ id: "image-test", type: "windows", shell: "cmd.exe", cwd: "C:\\project" });
      const image = "C:\\project\\clipboard.bmp";
      service.allowPastedImage("image-test", image);
      if (modalities?.length === 1 && modalities[0] === "text") {
        const before = service.snapshot("image-test").items;
        await expect(service.submit("image-test", "检查", [image])).rejects.toThrow("不支持图片输入");
        expect(service.snapshot("image-test").items).toEqual(before);
        expect(received.some(value => value.method === "turn/start")).toBe(false);
        await service.submit("image-test", "纯文字");
        await expect(service.submit("image-test", "追加", [image])).rejects.toThrow("不支持图片输入");
        expect(received.some(value => value.method === "turn/steer")).toBe(false);
        expect(service.snapshot("image-test").busy).toBe(true);
      } else {
        await service.submit("image-test", "检查", [image]);
        expect(received.find(value => value.method === "turn/start").params.input).toContainEqual({ type: "localImage", path: image });
      }
    } finally { service.shutdown(); }
  });
});


it("rejects a text-only default model before transferring a remote image", async () => {
  const received = [];
  const child = fakeProcess(received, request => request.method === "thread/start"
    ? { thread: { id: "thread-1", model: null } }
    : request.method === "model/list" ? { data: [{ id: "text", isDefault: true, inputModalities: ["text"] }] } : undefined);
  const transport = new EventEmitter();
  transport.write = data => child.stdin.write(data);
  transport.close = () => transport.emit("close", 0);
  child.stdout.on("data", data => transport.emit("stdout", data));
  const sshFileSystem = { fastPut: vi.fn(), cwd: vi.fn(), mkdir: vi.fn() };
  const service = createCodexAppServerSessionService({ environmentService: { resolve: () => ({}) },
    terminalManager: { broadcastAgentStatus: () => {} }, broadcast: () => {},
    sshAgentTransport: { createStdioTransport: async () => transport }, sshFileSystem });
  try {
    await service.start({ id: "remote-image", type: "ssh", cwd: "/srv/app" });
    const image = "C:\\project\\photo.png";
    service.allowFiles("remote-image", [image]);
    await expect(service.submit("remote-image", "", [image])).rejects.toThrow("不支持图片输入");
    expect(sshFileSystem.fastPut).not.toHaveBeenCalled();
    expect(sshFileSystem.cwd).not.toHaveBeenCalled();
    expect(service.snapshot("remote-image").items).toHaveLength(0);
    expect(received.some(value => value.method === "turn/start")).toBe(false);
  } finally { service.shutdown(); }
});
