const { displayItem, historyItems } = require("./snapshot-helpers.cjs");

const isCollaboration = item => ["collabToolCall", "collabAgentToolCall", "subAgentActivity"].includes(item?.type);
function runtimeStatus(value) {
  if (value?.type === "active") return value.activeFlags?.includes("waitingOnApproval") ? "waitingOnApproval"
    : value.activeFlags?.includes("waitingOnUserInput") ? "waitingOnUserInput" : "running";
  return { idle: "idle", notLoaded: "notLoaded", systemError: "failed" }[value?.type] || "unknown";
}

// Read-only observation: never resumes, subscribes to, or sends input to a child thread.
function createSubAgentObserver({ request, changed, intervalMs = 2000 }) {
  let root = null, generation = 0, members = new Map(), expanded = false, selected = null;
  let loading = false, error = null, warning = null, unsupported = false, timer = null, publishTimer = null;
  let operation = null, refreshAgain = false, disposed = false;
  let activeReads = 0; const readWaiters = [];
  async function readHistory(threadId, epoch) {
    if (activeReads < 2) activeReads += 1;
    else await new Promise(resolve => readWaiters.push(resolve));
    try { return valid(epoch) ? await request("thread/read", { threadId, includeTurns: true }) : null; }
    finally { const next = readWaiters.shift(); if (next) next(); else activeReads -= 1; }
  }
  const valid = epoch => !disposed && epoch === generation;
  function notify() {
    if (publishTimer || disposed || (!members.size && !expanded && !error && !warning)) return;
    publishTimer = setTimeout(() => { publishTimer = null; if (!disposed) changed(); }, 80);
  }
  function schedule() {
    clearTimeout(timer); timer = null;
    if (root && expanded && !disposed) timer = setTimeout(() => { timer = null; void refresh(); }, intervalMs);
  }
  function add(thread, parent = root) {
    if (!thread?.id || thread.id === root) return null;
    const existing = members.get(thread.id);
    const member = existing || { threadId: thread.id, parentThreadId: parent, name: thread.id.slice(0, 8), role: "",
      task: "", status: "unknown", createdAt: thread.createdAt || 0, items: [], loading: false, error: null, eventRevision: 0 };
    member.parentThreadId = thread.parentThreadId || member.parentThreadId;
    member.name = thread.agentNickname || thread.name || member.name;
    member.role = thread.agentRole || member.role;
    member.task = member.task || thread.preview || "";
    if (thread.status) {
      const status = runtimeStatus(thread.status);
      // Stored history reports notLoaded even for a previously completed agent.
      if (status !== "notLoaded" || !["completed", "failed", "shutdown", "interrupted"].includes(member.status)) member.status = status;
    }
    member.createdAt = thread.createdAt || member.createdAt;
    members.set(thread.id, member);
    if (!existing && members.size === 1) { expanded = true; selected = thread.id; schedule(); }
    return member;
  }
  function collaboration(item, sender = root) {
    if (!isCollaboration(item) || (sender !== root && !members.has(sender))) return;
    if (item.type === "subAgentActivity") {
      if (!item.agentThreadId) return;
      const member = members.get(item.agentThreadId) || add({ id: item.agentThreadId }, sender);
      if (!member) return;
      if (item.agentPath) member.name = item.agentPath;
      const status = { started: "running", interrupted: "interrupted", completed: "completed" }[item.kind];
      if (status) member.status = status;
      return;
    }
    const receivers = [...new Set([...(item.receiverThreadIds || []), item.receiverThreadId, item.newThreadId].filter(Boolean))];
    for (const threadId of receivers) {
      const spawning = /spawn/i.test(item.tool || "") || threadId === item.newThreadId;
      const member = members.get(threadId) || (spawning ? add({ id: threadId }, sender) : null);
      if (!member) continue;
      if (spawning && item.prompt) member.task = item.prompt;
      const state = item.agentsStates?.[threadId];
      if (state?.status || item.agentStatus) member.status = state?.status || item.agentStatus;
    }
  }
  function merge(member, item, incompleteHistory = false) {
    if (!item?.id) return;
    const index = member.items.findIndex(value => value.id === item.id);
    const previous = member.items[index];
    const value = { ...previous, ...item };
    if (incompleteHistory && previous?.text?.startsWith(item.text || "") && previous.text.length > (item.text || "").length) value.text = previous.text;
    if (item.type === "commandExecution" && !item.aggregatedOutput && previous?.output) value.output = previous.output;
    if (item.type === "commandExecution" && item.aggregatedOutput) {
      value.output = incompleteHistory && previous?.output?.startsWith(item.aggregatedOutput)
        && previous.output.length > item.aggregatedOutput.length ? previous.output : item.aggregatedOutput;
    }
    if (index < 0) member.items.push(value); else member.items[index] = value;
  }
  async function run(epoch) {
    loading = true; error = null; notify();
    try {
      if (!unsupported) {
        const found = []; let cursor;
        do {
          const result = await request("thread/list", { ancestorThreadId: root, sourceKinds: ["subAgent"], limit: 100, ...(cursor ? { cursor } : {}) });
          if (!valid(epoch)) return;
          found.push(...(result.data || []));
          const next = result.nextCursor; if (!next || next === cursor) break; cursor = next;
        } while (valid(epoch));
        // Require a confirmed path to the root, even if an old server silently ignores the filter.
        let pending = found;
        while (pending.length) {
          const remaining = pending.filter(thread => {
            if (thread.parentThreadId === root || members.has(thread.parentThreadId)) { add(thread); return false; }
            return true;
          });
          if (remaining.length === pending.length) break;
          pending = remaining;
        }
      }
    } catch (cause) {
      if (!valid(epoch)) return;
      if (/method.*not found|unknown|unsupported|invalid.*(param|field)|ancestorThreadId|不支持/i.test(cause.message)) {
        unsupported = true; warning = "当前 Codex 不支持后代列表筛选，仅显示已发现的子 Agent，列表可能不完整。";
      } else error = cause.message;
    }
    if (!valid(epoch)) return;
    const member = members.get(selected);
    if (expanded && member) {
      member.loading = true; member.error = null; notify();
      const revision = member.eventRevision;
      try {
        const result = await readHistory(member.threadId, epoch);
        if (!valid(epoch)) return;
        if (result.thread?.id !== member.threadId) throw new Error("子线程读取结果不匹配。");
        if (member.eventRevision === revision) {
          add(result.thread);
          // Keep streamed items missing from a not-yet-flushed rollout.
          for (const item of historyItems(result.thread)) merge(member, item, result.thread.turns?.find(turn => turn.id === item.turnId)?.status === "inProgress");
          for (const item of member.items) collaboration(item, member.threadId);
          const turn = result.thread.turns?.at(-1);
          if (turn?.status === "failed") member.status = "failed";
          else if (["idle", "notLoaded"].includes(result.thread.status?.type)) {
            if (["completed", "interrupted"].includes(turn?.status)) member.status = turn.status;
            else if (turn?.status === "inProgress") member.status = "running";
          }
        }
      } catch (cause) { if (valid(epoch)) member.error = cause.message; }
      finally { if (valid(epoch)) member.loading = false; }
    }
    if (valid(epoch)) { loading = false; notify(); }
  }
  function refresh() {
    if (!root || disposed) return Promise.resolve();
    if (operation) { refreshAgain = true; return operation; }
    clearTimeout(timer); timer = null;
    const epoch = generation;
    operation = run(epoch).finally(() => {
      if (!valid(epoch)) return;
      operation = null;
      if (refreshAgain && expanded) { refreshAgain = false; void refresh(); } else { refreshAgain = false; schedule(); }
    });
    return operation;
  }
  function reset(threadId, items = []) {
    generation += 1; clearTimeout(timer); clearTimeout(publishTimer); timer = publishTimer = null;
    root = threadId; members = new Map(); selected = null; expanded = false; loading = false;
    error = warning = null; unsupported = false; operation = null; refreshAgain = false;
    for (const item of items) collaboration(item);
    if (root) void refresh();
  }
  function observe(method, params = {}) {
    if (!root || disposed) return false;
    if (method === "thread/started" && params.thread?.parentThreadId
      && (params.thread.parentThreadId === root || members.has(params.thread.parentThreadId))) { add(params.thread); notify(); return true; }
    const threadId = params.threadId || params.thread?.id;
    if (threadId === root) {
      if (isCollaboration(params.item)) { collaboration(params.item); notify(); }
      return false;
    }
    const member = members.get(threadId);
    if (!member) return false;
    member.eventRevision += 1;
    if (method === "thread/status/changed") member.status = runtimeStatus(params.status);
    if (method === "thread/name/updated" && params.name) member.name = params.name;
    if (method === "thread/closed") member.status = "notLoaded";
    if (method === "thread/deleted") member.status = "deleted";
    if (method === "turn/started") member.status = "running";
    if (method === "turn/plan/updated") merge(member, { id: `turn-plan:${params.turnId}`, type: "turnPlan", turnId: params.turnId, plan: params.plan, explanation: params.explanation });
    if (method === "turn/completed") member.status = params.turn?.status === "failed" ? "failed" : params.turn?.status === "interrupted" ? "interrupted" : "completed";
    if (params.item && ["item/started", "item/completed"].includes(method)) {
      const item = displayItem(params.item);
      merge(member, { ...item, ...(params.turnId ? { turnId: params.turnId } : {}) }); collaboration(item, threadId);
    }
    const item = member.items.find(value => value.id === params.itemId);
    if (item && ["item/agentMessage/delta", "item/plan/delta"].includes(method)) item.text = (item.text || "") + (params.delta || "");
    if (item && method === "item/commandExecution/outputDelta") item.output = (item.output || item.aggregatedOutput || "") + (params.delta || "");
    if (item && method === "item/reasoning/summaryPartAdded") {
      const summary = [...(item.summary || [])]; summary[params.summaryIndex ?? summary.length] = ""; item.summary = summary;
    }
    if (item && method === "item/reasoning/summaryTextDelta") {
      const summary = [...(item.summary || [])]; const index = params.summaryIndex || 0;
      summary[index] = (summary[index] || "") + (params.delta || ""); item.summary = summary;
    }
    notify(); return true;
  }
  function setView(value, threadId = selected) {
    if (typeof value !== "boolean") throw new Error("无效的子 Agent 面板状态。");
    if (threadId != null && !members.has(threadId)) throw new Error("子 Agent 不属于当前会话。");
    expanded = value; selected = threadId; notify();
    if (expanded) void refresh(); else { clearTimeout(timer); timer = null; }
  }
  function snapshot() {
    return { expanded, selectedThreadId: selected, loading, error, warning,
      members: [...members.values()].sort((a, b) => a.createdAt - b.createdAt).map(({ eventRevision, ...member }) => ({ ...member, items: member.items.map(item => ({ ...item })) })) };
  }
  function dispose() { loading = false; for (const member of members.values()) member.loading = false; disposed = true; generation += 1; clearTimeout(timer); clearTimeout(publishTimer); }
  return { reset, observe, setView, refresh, snapshot, dispose };
}
module.exports = { createSubAgentObserver };
