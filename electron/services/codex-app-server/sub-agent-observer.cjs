const { isDeepStrictEqual } = require("node:util");
const { displayItem, historyItems } = require("./snapshot-helpers.cjs");
const COMMAND_OUTPUT_LIMIT = 16000;

const isCollaboration = item => ["collabToolCall", "collabAgentToolCall", "subAgentActivity"].includes(item?.type);
function runtimeStatus(value) {
  if (value?.type === "active") return value.activeFlags?.includes("waitingOnApproval") ? "waitingOnApproval"
    : value.activeFlags?.includes("waitingOnUserInput") ? "waitingOnUserInput" : "running";
  return { idle: "idle", notLoaded: "notLoaded", systemError: "failed" }[value?.type] || "unknown";
}

// Read-only observation: never resumes, subscribes to, or sends input to a child thread.
function createSubAgentObserver({ request, changed, deltaChanged = () => {}, intervalMs = 2000 }) {
  let root = null, generation = 0, members = new Map(), expanded = false, selected = null;
  let loading = false, error = null, warning = null, unsupported = false, timer = null, publishTimer = null;
  let operation = null, refreshAgain = false, disposed = false;
  const terminalStatuses = ["completed", "failed", "shutdown", "interrupted", "deleted"];
  let textDeltas = [];
  const commandOutputLengths = new WeakMap();
  // History backs off independently of the fixed discovery interval; never publish bookkeeping.
  const historyPolls = new WeakMap();
  const maxHistoryIntervalMs = Math.max(intervalMs, 30000);
  function resetHistoryPoll(member) {
    historyPolls.set(member, { delay: intervalMs, due: 0, status: member.status });
  }
  function takeTextDeltas() { const result = textDeltas; textDeltas = []; return result; }
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
    if (root && expanded && !disposed) timer = setTimeout(() => { timer = null; void refresh(false); }, intervalMs);
  }
  function add(thread, parent = root) {
    if (!thread?.id || thread.id === root) return null;
    const existing = members.get(thread.id);
    const member = existing || { threadId: thread.id, parentThreadId: parent, name: thread.id.slice(0, 8), role: "",
      task: "", status: "unknown", createdAt: thread.createdAt || 0, items: [], loading: false, error: null, eventRevision: 0, historyRevision: -1 };
    member.parentThreadId = thread.parentThreadId || member.parentThreadId;
    member.name = thread.agentNickname || thread.name || member.name;
    member.role = thread.agentRole || member.role;
    member.task = member.task || thread.preview || "";
    if (thread.status) {
      const status = runtimeStatus(thread.status);
      // Inactive list records must not erase the terminal state learned from turns/events.
      if (!["idle", "notLoaded"].includes(status) || !terminalStatuses.includes(member.status)) member.status = status;
    }
    member.createdAt = thread.createdAt || member.createdAt;
    if (!existing || member.status !== historyPolls.get(member)?.status) resetHistoryPoll(member);
    members.set(thread.id, member);
    if (!existing && members.size === 1) { expanded = true; selected = thread.id; schedule(); }
    return member;
  }
  function collaboration(item, sender = root, live = false) {
    if (!isCollaboration(item) || (sender !== root && !members.has(sender))) return;
    if (item.type === "subAgentActivity") {
      if (!item.agentThreadId) return;
      const member = members.get(item.agentThreadId) || add({ id: item.agentThreadId }, sender);
      if (!member) return;
      if (live) { member.eventRevision += 1; resetHistoryPoll(member); }
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
      if (live) { member.eventRevision += 1; resetHistoryPoll(member); }
      if (spawning && item.prompt) member.task = item.prompt;
      const state = item.agentsStates?.[threadId];
      if (state?.status || item.agentStatus) member.status = state?.status || item.agentStatus;
    }
  }
  function merge(member, item, incompleteHistory = false, itemIndices = null) {
    if (!item?.id) return;
    const index = itemIndices ? (itemIndices.get(item.id) ?? -1) : member.items.findIndex(value => value.id === item.id);
    const previous = member.items[index];
    const value = { ...previous, ...item };
    if (incompleteHistory && previous?.text?.startsWith(item.text || "") && previous.text.length > (item.text || "").length) value.text = previous.text;
    if (incompleteHistory && Array.isArray(previous?.summary) && Array.isArray(item.summary)) {
      // A running rollout may lag behind streamed segments or omit them entirely.
      const summary = [...item.summary];
      previous.summary.forEach((text, index) => {
        if (index >= summary.length || text.startsWith(summary[index] || "")) summary[index] = text;
      });
      value.summary = summary;
    }
    if (item.type === "commandExecution" && !item.aggregatedOutput && item.output == null && previous?.output) value.output = previous.output;
    if (item.type === "commandExecution" && item.aggregatedOutput) {
      const previousLength = commandOutputLengths.get(previous) || previous?.output?.length || 0;
      const retainedStart = Math.max(0, previousLength - COMMAND_OUTPUT_LIMIT);
      const overlap = item.aggregatedOutput.slice(retainedStart);
      const keepStream = incompleteHistory && previousLength > item.aggregatedOutput.length
        && previous?.output?.startsWith(overlap);
      value.output = keepStream ? previous.output : item.aggregatedOutput;
      commandOutputLengths.set(value, keepStream ? previousLength : item.aggregatedOutput.length);
    }
    if (value.type === "commandExecution") {
      if (!commandOutputLengths.has(value)) commandOutputLengths.set(value,
        item.output == null ? commandOutputLengths.get(previous) || value.output?.length || 0 : item.output.length);
      value.output = (value.output || "").slice(-COMMAND_OUTPUT_LIMIT);
      delete value.aggregatedOutput;
    }
    if (index < 0) {
      if (itemIndices) itemIndices.set(item.id, member.items.length);
      member.items.push(value);
    } else {
      if (isDeepStrictEqual(previous, value)) {
        if (commandOutputLengths.has(value)) commandOutputLengths.set(previous, commandOutputLengths.get(value));
        return false;
      }
      member.items[index] = value;
    }
    return true;
  }
  async function run(epoch, force) {
    // Automatic polls publish only the final, changed state; loading indicators are for explicit refreshes.
    // Compare metadata only: cached terminal histories must not be copied or traversed on every poll.
    const previous = force ? null : viewState(false);
    let historyChanged = false;
    if (force) loading = true;
    error = null; if (force) notify();
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
    if (expanded && member && (force || member.historyRevision !== member.eventRevision
      || (!terminalStatuses.includes(member.status) && Date.now() >= (historyPolls.get(member)?.due || 0)) || member.error)) {
      if (force) member.loading = true;
      member.error = null; if (force) notify();
      if (force) resetHistoryPoll(member);
      const revision = member.eventRevision;
      const previousStatus = member.status;
      try {
        const result = await readHistory(member.threadId, epoch);
        if (!valid(epoch)) return;
        if (result.thread?.id !== member.threadId) throw new Error("子线程读取结果不匹配。");
        if (member.eventRevision === revision) {
          member.historyRevision = revision;
          add(result.thread);
          // Keep streamed items missing from a not-yet-flushed rollout.
          const turnStatuses = new Map((result.thread.turns || []).map(turn => [turn.id, turn.status]));
          const itemIndices = new Map(member.items.map((item, index) => [item.id, index]));
          for (const item of historyItems(result.thread)) {
            historyChanged = merge(member, item, turnStatuses.get(item.turnId) === "inProgress", itemIndices) || historyChanged;
          }
          for (const item of member.items) collaboration(item, member.threadId);
          const turn = result.thread.turns?.at(-1);
          if (turn?.status === "failed") member.status = "failed";
          else if (["idle", "notLoaded"].includes(result.thread.status?.type)) {
            if (["completed", "interrupted"].includes(turn?.status)) member.status = turn.status;
            else if (turn?.status === "inProgress") member.status = "running";
          }
          const poll = historyPolls.get(member);
          poll.delay = force || historyChanged || previousStatus !== member.status
            ? intervalMs : Math.min(poll.delay * 2, maxHistoryIntervalMs);
          poll.due = Date.now() + poll.delay;
          poll.status = member.status;
        }
      } catch (cause) { if (valid(epoch)) { member.error = cause.message; resetHistoryPoll(member); } }
      finally { if (valid(epoch)) member.loading = false; }
    }
    if (valid(epoch)) {
      loading = false;
      if (force || historyChanged || !isDeepStrictEqual(previous, viewState(false))) notify();
    }
  }
  function refresh(force = true) {
    if (!root || disposed) return Promise.resolve();
    if (operation) { refreshAgain ||= force; return operation; }
    clearTimeout(timer); timer = null;
    const epoch = generation;
    operation = run(epoch, force).finally(() => {
      if (!valid(epoch)) return;
      operation = null;
      if (refreshAgain && expanded) { refreshAgain = false; void refresh(); } else { refreshAgain = false; schedule(); }
    });
    return operation;
  }
  function reset(threadId, items = []) {
    textDeltas = []; generation += 1; clearTimeout(timer); clearTimeout(publishTimer); timer = publishTimer = null;
    root = threadId; members = new Map(); selected = null; expanded = false; loading = false;
    error = warning = null; unsupported = false; operation = null; refreshAgain = false;
    for (const item of items) collaboration(item);
    if (root) void refresh();
  }
  function observe(method, params = {}) {
    if (!root || disposed) return false;
    if (method === "thread/started" && params.thread?.parentThreadId
      && (params.thread.parentThreadId === root || members.has(params.thread.parentThreadId))) {
      const member = add(params.thread);
      if (member) { member.eventRevision += 1; resetHistoryPoll(member); }
      notify(); return true;
    }
    const threadId = params.threadId || params.thread?.id;
    if (threadId === root) {
      if (isCollaboration(params.item)) { collaboration(params.item, root, true); notify(); }
      return false;
    }
    const member = members.get(threadId);
    if (!member) return false;
    member.eventRevision += 1; resetHistoryPoll(member);
    if (method === "thread/status/changed") member.status = runtimeStatus(params.status);
    if (method === "thread/name/updated" && params.name) member.name = params.name;
    if (method === "thread/closed") member.status = "notLoaded";
    if (method === "thread/deleted") member.status = "deleted";
    if (method === "turn/started") member.status = "running";
    if (method === "turn/plan/updated") merge(member, { id: `turn-plan:${params.turnId}`, type: "turnPlan", turnId: params.turnId, plan: params.plan, explanation: params.explanation });
    if (method === "turn/completed") member.status = params.turn?.status === "failed" ? "failed" : params.turn?.status === "interrupted" ? "interrupted" : "completed";
    if (params.item && ["item/started", "item/completed"].includes(method)) {
      const item = displayItem(params.item);
      merge(member, { ...item, ...(params.turnId ? { turnId: params.turnId } : {}) }); collaboration(item, threadId, true);
    }
    const item = member.items.find(value => value.id === params.itemId);
    if (item && ["item/agentMessage/delta", "item/plan/delta"].includes(method)) item.text = (item.text || "") + (params.delta || "");
    if (item && method === "item/commandExecution/outputDelta") {
      commandOutputLengths.set(item, (commandOutputLengths.get(item) || item.output?.length || 0) + (params.delta || "").length);
      item.output = ((item.output || "") + (params.delta || "").slice(-COMMAND_OUTPUT_LIMIT)).slice(-COMMAND_OUTPUT_LIMIT);
    }
    if (item && method === "item/reasoning/summaryPartAdded") {
      const summary = [...(item.summary || [])]; summary[params.summaryIndex ?? summary.length] = ""; item.summary = summary;
    }
    if (item && method === "item/reasoning/summaryTextDelta") {
      const summary = [...(item.summary || [])]; const index = params.summaryIndex || 0;
      summary[index] = (summary[index] || "") + (params.delta || ""); item.summary = summary;
    }
    const field = { "item/agentMessage/delta": "text", "item/plan/delta": "text",
      "item/commandExecution/outputDelta": "output", "item/reasoning/summaryTextDelta": "summary" }[method];
    if (field) {
      if (expanded && item && params.delta) {
        textDeltas.push({ threadId, itemId: item.id, field, delta: field === "output" ? params.delta.slice(-COMMAND_OUTPUT_LIMIT) : params.delta,
          ...(field === "summary" ? { summaryIndex: params.summaryIndex || 0 } : {}) });
        deltaChanged();
      }
    } else notify();
    return true;
  }
  function setView(value, threadId = selected) {
    if (typeof value !== "boolean") throw new Error("无效的子 Agent 面板状态。");
    if (threadId != null && !members.has(threadId)) throw new Error("子 Agent 不属于当前会话。");
    textDeltas = []; expanded = value; selected = threadId; notify();
    if (expanded) void refresh(); else { clearTimeout(timer); timer = null; }
  }
  function viewState(includeItems) {
    return { expanded, selectedThreadId: selected, loading, error, warning,
      members: [...members.values()].sort((a, b) => a.createdAt - b.createdAt).map(({ eventRevision, historyRevision, items, ...member }) => ({ ...member,
        ...(includeItems ? { items: items.map(item => ({ ...item })) } : {}) })) };
  }
  function snapshot() { return viewState(true); }
  function dispose() { loading = false; for (const member of members.values()) member.loading = false; disposed = true; textDeltas = []; generation += 1; clearTimeout(timer); clearTimeout(publishTimer); }
  return { reset, observe, setView, refresh, snapshot, takeTextDeltas, dispose };
}
module.exports = { createSubAgentObserver };
