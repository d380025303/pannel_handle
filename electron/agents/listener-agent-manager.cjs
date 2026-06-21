const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const picomatch = require("picomatch");
const { CronExpressionParser } = require("cron-parser");
const { MAX_OUTPUT_BYTES, PROVIDERS, normalizeListenerAgent, renderPrompt } = require("./listener-agent-store.cjs");

const POLL_MS = 2000;

function relativePath(root, value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  const base = String(root || "").replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : normalized;
}

function matchesTrigger(trigger, filePath) {
  const value = String(filePath || "").replace(/\\/g, "/");
  const included = trigger.include.some(pattern => picomatch.isMatch(value, pattern, { dot: true }));
  return included && !matchesExcluded(trigger.exclude, value);
}

function matchesExcluded(patterns, value) {
  return patterns.some(pattern => picomatch.isMatch(value, pattern, { dot: true })
    || (pattern.endsWith("/**") && picomatch.isMatch(value, pattern.slice(0, -3), { dot: true })));
}

function diffSnapshots(previous, next) {
  const changes = [];
  for (const [file, signature] of next) {
    if (!previous.has(file)) changes.push({ event: "add", path: file });
    else if (previous.get(file) !== signature) changes.push({ event: "change", path: file });
  }
  for (const file of previous.keys()) if (!next.has(file)) changes.push({ event: "unlink", path: file });
  return changes;
}

function appendBounded(current, chunk) {
  const next = `${current}${chunk}`;
  const buffer = Buffer.from(next, "utf-8");
  return buffer.length <= MAX_OUTPUT_BYTES ? next : buffer.subarray(0, MAX_OUTPUT_BYTES).toString("utf-8");
}

function createListenerAgentManager({ terminalManager, sessionStore, historyStore, cli, sshSessionRuntime, broadcast }) {
  const runtimes = new Map();

  function getHost(templateId) {
    return terminalManager.getSessions()
      .filter(session => (session.templateId || session.id) === templateId)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  function hostSignature(host) {
    return JSON.stringify({ id: host.id, type: host.type, cwd: host.cwd, wslDistro: host.wslDistro, sshConfig: host.sshConfig });
  }

  function buildCliSession(agent, host) {
    if (!agent.cliTemplateId) return host;
    const template = sessionStore.getTemplate(agent.cliTemplateId);
    if (!template) return host;
    const cliSession = {
      cwd: template.cwd || host.cwd,
      type: template.type || host.type,
      wslDistro: template.wslDistro || host.wslDistro,
      sshConfig: template.sshConfig || host.sshConfig
    };
    if (template.type === "ssh") {
      const sshSession = terminalManager.getSessions()
        .find(s => (s.templateId || s.id) === agent.cliTemplateId);
      if (sshSession) cliSession.id = sshSession.id;
    }
    return cliSession;
  }

  function stateFor(templateId) {
    const template = sessionStore.getTemplate(templateId);
    const runtime = runtimes.get(templateId);
    return {
      templateId,
      active: Boolean(runtime),
      hostSessionId: runtime?.host?.id,
      agents: (template?.listenerAgents || []).map(agent => ({
        ...agent,
        running: runtime?.agents.get(agent.id)?.running || false,
        pending: runtime?.agents.get(agent.id)?.pending || false
      }))
    };
  }

  function emit(templateId) {
    broadcast("listener-agents:changed", stateFor(templateId));
  }

  async function scanWsl(host) {
    const command = `find . -type f -printf '%P\\t%T@\\t%s\\n' 2>/dev/null`;
    const result = spawnSync("wsl.exe", ["-d", host.wslDistro, "--cd", host.cwd, "--", "sh", "-lc", command], { encoding: "utf-8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(String(result.stderr || "WSL 文件扫描失败。").trim());
    const snapshot = new Map();
    for (const line of String(result.stdout || "").split("\n")) {
      const [file, modified, size] = line.split("\t");
      if (file) snapshot.set(file.replace(/\\/g, "/"), `${modified}:${size}`);
    }
    return snapshot;
  }

  async function scanSsh(host) {
    const sftp = await sshSessionRuntime.createSftpClient(host.id);
    const snapshot = new Map();
    async function walk(remotePath, relative = "") {
      const entries = await sftp.list(remotePath);
      for (const entry of entries) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.type === "d") await walk(path.posix.join(remotePath, entry.name), childRelative);
        else if (entry.type === "-") snapshot.set(childRelative, `${entry.modifyTime}:${entry.size}`);
      }
    }
    try { await walk(host.cwd); } finally { await sftp.end(); }
    return snapshot;
  }

  function queueTrigger(runtime, agent, trigger, changedFiles = []) {
    const agentRuntime = runtime.agents.get(agent.id);
    if (!agentRuntime || !agent.enabled || !trigger.enabled) return;
    const pending = agentRuntime.pendingByTrigger.get(trigger.id) || new Set();
    changedFiles.forEach(file => pending.add(file));
    agentRuntime.pendingByTrigger.set(trigger.id, pending);
    if (agentRuntime.running) {
      agentRuntime.pending = true;
      emit(runtime.templateId);
      return;
    }
    void runNext(runtime, agent);
  }

  async function runNext(runtime, agent) {
    const agentRuntime = runtime.agents.get(agent.id);
    const next = agent.triggers.find(trigger => agentRuntime.pendingByTrigger.has(trigger.id));
    if (!next || agentRuntime.running) return;
    const changedFiles = [...agentRuntime.pendingByTrigger.get(next.id)];
    agentRuntime.pendingByTrigger.delete(next.id);
    agentRuntime.pending = agentRuntime.pendingByTrigger.size > 0;
    agentRuntime.running = true;
    agentRuntime.suppressFileEvents = false;
    emit(runtime.templateId);
    const startedAt = Date.now();
    const runId = randomUUID();
    let stdout = "";
    let stderr = "";
    let status = "completed";
    let exitCode = 0;
    try {
      const prompt = renderPrompt({ prompt: next.prompt, cwd: runtime.host.cwd, agent, trigger: next, changedFiles });
      const cliSession = buildCliSession(agent, runtime.host);
      const handle = await cli.run(cliSession, agent, prompt, {
        onStdout: chunk => { stdout = appendBounded(stdout, chunk); broadcast("listener-agents:output", { templateId: runtime.templateId, agentId: agent.id, runId, stream: "stdout", chunk }); },
        onStderr: chunk => { stderr = appendBounded(stderr, chunk); broadcast("listener-agents:output", { templateId: runtime.templateId, agentId: agent.id, runId, stream: "stderr", chunk }); }
      });
      agentRuntime.handle = handle;
      const timeout = setTimeout(() => handle.cancel(), agent.timeoutMinutes * 60 * 1000);
      const result = await handle.promise;
      clearTimeout(timeout);
      exitCode = result.exitCode;
      if (exitCode !== 0) status = agentRuntime.cancelRequested ? "canceled" : "failed";
    } catch (err) {
      status = agentRuntime.cancelRequested ? "canceled" : "failed";
      exitCode = -1;
      stderr += `${stderr ? "\n" : ""}${err instanceof Error ? err.message : String(err)}`;
    }
    if (agent.permission === "write" && agent.ignoreOwnChanges) {
      for (const trigger of agent.triggers) {
        if (trigger.type === "file") agentRuntime.pendingByTrigger.delete(trigger.id);
      }
      agentRuntime.suppressFileEvents = true;
      setTimeout(() => { agentRuntime.suppressFileEvents = false; }, POLL_MS + 500);
    }
    agentRuntime.handle = undefined;
    agentRuntime.cancelRequested = false;
    agentRuntime.running = false;
    agentRuntime.pending = agentRuntime.pendingByTrigger.size > 0;
    historyStore.append(runtime.templateId, agent.id, {
      id: runId,
      triggerId: next.id,
      triggerName: next.name,
      triggerType: next.type,
      changedFiles,
      status,
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      exitCode,
      stdout,
      stderr
    });
    emit(runtime.templateId);
    if (agentRuntime.pending) void runNext(runtime, agent);
  }

  async function startFileWatch(runtime, agent, trigger, agentRuntime) {
    if (runtime.host.type === "windows") {
      const { watch } = await import("chokidar");
      const watcher = watch(".", {
        cwd: runtime.host.cwd,
        ignored: file => {
          const relative = relativePath(runtime.host.cwd, file);
          return relative !== "." && matchesExcluded(trigger.exclude, relative);
        },
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
      });
      const changed = new Set();
      let timer;
      const flush = () => {
        timer = undefined;
        if (!agentRuntime.suppressFileEvents && changed.size) queueTrigger(runtime, agent, trigger, [...changed]);
        changed.clear();
      };
      for (const event of trigger.events) watcher.on(event, file => {
        const relative = String(file).replace(/\\/g, "/");
        if (!matchesTrigger(trigger, relative)) return;
        changed.add(relative);
        clearTimeout(timer);
        timer = setTimeout(flush, trigger.debounceMs);
      });
      runtime.cleanups.push(() => { clearTimeout(timer); void watcher.close(); });
      return;
    }
    let stopped = false;
    let previous = runtime.host.type === "ssh" ? await scanSsh(runtime.host) : await scanWsl(runtime.host);
    const poll = async () => {
      if (stopped) return;
      try {
        const next = runtime.host.type === "ssh" ? await scanSsh(runtime.host) : await scanWsl(runtime.host);
        const files = diffSnapshots(previous, next)
          .filter(change => trigger.events.includes(change.event) && matchesTrigger(trigger, change.path))
          .map(change => change.path);
        previous = next;
        if (!agentRuntime.suppressFileEvents && files.length) queueTrigger(runtime, agent, trigger, files);
      } catch (err) {
        console.error("Listener Agent file polling failed:", err);
      }
      if (!stopped) agentRuntime.pollTimers.push(setTimeout(poll, POLL_MS));
    };
    agentRuntime.pollTimers.push(setTimeout(poll, POLL_MS));
    runtime.cleanups.push(() => { stopped = true; agentRuntime.pollTimers.forEach(clearTimeout); });
  }

  function startSchedule(runtime, agent, trigger) {
    let stopped = false;
    let timer;
    const schedule = () => {
      if (stopped) return;
      let delay;
      if (trigger.type === "interval") delay = trigger.intervalMinutes * 60 * 1000;
      else delay = Math.max(1000, CronExpressionParser.parse(trigger.cron, { currentDate: new Date() }).next().getTime() - Date.now());
      timer = setTimeout(() => { queueTrigger(runtime, agent, trigger); schedule(); }, delay);
    };
    schedule();
    runtime.cleanups.push(() => { stopped = true; clearTimeout(timer); });
  }

  async function startTemplate(templateId, host) {
    const template = sessionStore.getTemplate(templateId);
    const runtime = { templateId, host, hostSignature: hostSignature(host), agents: new Map(), cleanups: [] };
    runtimes.set(templateId, runtime);
    try {
      for (const agent of template?.listenerAgents || []) {
        const agentRuntime = { running: false, pending: false, pendingByTrigger: new Map(), pollTimers: [], cancelRequested: false };
        runtime.agents.set(agent.id, agentRuntime);
        if (!agent.enabled) continue;
        for (const trigger of agent.triggers.filter(item => item.enabled)) {
          if (trigger.type === "file") await startFileWatch(runtime, agent, trigger, agentRuntime);
          else if (trigger.type !== "manual") startSchedule(runtime, agent, trigger);
        }
      }
    } catch (err) {
      runtime.cleanups.forEach(cleanup => cleanup());
      runtimes.delete(templateId);
      throw err;
    }
    emit(templateId);
  }

  function stopTemplate(templateId) {
    const runtime = runtimes.get(templateId);
    if (!runtime) return;
    runtime.cleanups.forEach(cleanup => cleanup());
    for (const agentRuntime of runtime.agents.values()) agentRuntime.handle?.cancel();
    runtimes.delete(templateId);
    emit(templateId);
  }

  async function sync(templateId) {
    const host = getHost(templateId);
    const current = runtimes.get(templateId);
    if (!host) { stopTemplate(templateId); return; }
    if (current?.hostSignature === hostSignature(host)) return;
    stopTemplate(templateId);
    await startTemplate(templateId, host);
  }

  async function syncAll() {
    const templateIds = new Set(terminalManager.getSessions().map(session => session.templateId || session.id));
    for (const id of runtimes.keys()) if (!templateIds.has(id)) stopTemplate(id);
    for (const id of templateIds) await sync(id);
  }

  async function saveAgent(templateId, input) {
    const template = sessionStore.getTemplate(templateId);
    if (!template) throw new Error("未找到会话模板。");
    const agent = normalizeListenerAgent(input);
    if (agent.cliTemplateId) {
      const cliTemplate = sessionStore.getTemplate(agent.cliTemplateId);
      if (!cliTemplate) throw new Error("引用的 CLI 模板不存在。");
      if (!PROVIDERS.has(cliTemplate.agentProvider)) throw new Error(`模板 "${cliTemplate.title}" 未设置 Agent CLI。`);
      agent.provider = cliTemplate.agentProvider;
    }
    const agents = [...(template.listenerAgents || [])];
    const index = agents.findIndex(item => item.id === agent.id);
    if (index >= 0) agents[index] = agent; else agents.push(agent);
    sessionStore.updateLibrary(templateId, { listenerAgents: agents });
    stopTemplate(templateId);
    await sync(templateId);
    return stateFor(templateId);
  }

  async function deleteAgent(templateId, agentId) {
    const template = sessionStore.getTemplate(templateId);
    sessionStore.updateLibrary(templateId, { listenerAgents: (template?.listenerAgents || []).filter(agent => agent.id !== agentId) });
    historyStore.clear(templateId, agentId);
    stopTemplate(templateId);
    await sync(templateId);
    return stateFor(templateId);
  }

  function runNow(templateId, agentId, triggerId) {
    const runtime = runtimes.get(templateId);
    if (!runtime) throw new Error("对应会话未运行。");
    const agent = sessionStore.getTemplate(templateId)?.listenerAgents?.find(item => item.id === agentId);
    const trigger = agent?.triggers.find(item => item.id === triggerId);
    if (!agent || !trigger) throw new Error("未找到 Agent 或触发器。");
    queueTrigger(runtime, agent, trigger);
    return stateFor(templateId);
  }

  function cancel(templateId, agentId) {
    const agentRuntime = runtimes.get(templateId)?.agents.get(agentId);
    if (agentRuntime?.handle) { agentRuntime.cancelRequested = true; agentRuntime.handle.cancel(); }
    return stateFor(templateId);
  }

  function shutdown() {
    for (const id of [...runtimes.keys()]) stopTemplate(id);
  }

  return {
    stateFor,
    sync,
    syncAll,
    saveAgent,
    deleteAgent,
    runNow,
    cancel,
    listHistory: (templateId, agentId) => historyStore.list(templateId, agentId),
    clearHistory: (templateId, agentId) => { historyStore.clear(templateId, agentId); return []; },
    removeTemplate: templateId => { stopTemplate(templateId); historyStore.removeTemplate(templateId); },
    shutdown
  };
}

module.exports = { POLL_MS, appendBounded, createListenerAgentManager, diffSnapshots, matchesTrigger, relativePath };
