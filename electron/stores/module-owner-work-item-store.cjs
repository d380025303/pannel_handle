const { randomUUID } = require("node:crypto");
const ACTIVE = ["creating", "running", "uncertain"];

function createWorkItemStore(database, transaction) {
  const db = () => {
    const value = database();
    if (!value) throw new Error("SQLite 任务存储不可用。");
    return value;
  };
  function initializeWorkItems() {
    db().exec(`CREATE TABLE IF NOT EXISTS app_module_owner_work_items(
      id TEXT PRIMARY KEY, source_run_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
      owner_id TEXT NOT NULL, template_id TEXT NOT NULL, status TEXT NOT NULL,
      version INTEGER NOT NULL, created_at INTEGER NOT NULL, output TEXT NOT NULL,
      task_name TEXT NOT NULL, owner_name TEXT NOT NULL, template_name TEXT NOT NULL,
      value_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS app_module_owner_work_items_order ON app_module_owner_work_items(created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS app_module_owner_work_items_filter ON app_module_owner_work_items(template_id,owner_id,status,created_at DESC);
      CREATE TABLE IF NOT EXISTS app_module_owner_work_item_attempts(
        id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, status TEXT NOT NULL,
        started_at INTEGER NOT NULL, value_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS app_module_owner_work_item_attempts_order ON app_module_owner_work_item_attempts(work_item_id,started_at DESC,id DESC);`);
    db().prepare("INSERT INTO app_migrations(version,completed_at) VALUES(4,?) ON CONFLICT(version) DO NOTHING").run(Date.now());
  }
  function getWorkItem(id) {
    const row = db().prepare("SELECT value_json FROM app_module_owner_work_items WHERE id=?").get(id);
    if (!row) throw new Error("任务不存在。");
    return JSON.parse(row.value_json);
  }
  function writeItem(value) {
    db().prepare("UPDATE app_module_owner_work_items SET status=?,version=?,value_json=? WHERE id=?")
      .run(value.status, value.version, JSON.stringify(value), value.id);
    return value;
  }
  function insertWorkItem(value) {
    const item = { ...value, id: randomUUID(), status: "pending", version: 1, createdAt: value.createdAt || Date.now(), updatedAt: Date.now() };
    db().prepare(`INSERT INTO app_module_owner_work_items(id,source_run_id,task_id,owner_id,template_id,status,version,created_at,output,task_name,owner_name,template_name,value_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_run_id) DO NOTHING`).run(item.id, item.sourceRunId, item.taskId, item.ownerId, item.templateId,
      item.status, item.version, item.createdAt, item.output, item.taskName, item.owner.name, item.template.title, JSON.stringify(item));
    return JSON.parse(db().prepare("SELECT value_json FROM app_module_owner_work_items WHERE source_run_id=?").get(item.sourceRunId).value_json);
  }
  function listWorkItems({ templateId, ownerId, status, keyword, page = 0 } = {}) {
    const conditions = []; const args = [];
    for (const [field, value] of [["template_id", templateId], ["owner_id", ownerId], ["status", status]]) {
      if (value) { conditions.push(`${field}=?`); args.push(value); }
    }
    if (keyword) { conditions.push("(instr(lower(output),lower(?))>0 OR instr(lower(task_name),lower(?))>0 OR instr(lower(owner_name),lower(?))>0 OR instr(lower(template_name),lower(?))>0)"); args.push(keyword, keyword, keyword, keyword); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = db().prepare(`SELECT COUNT(*) AS count FROM app_module_owner_work_items ${where}`).get(...args).count;
    const records = db().prepare(`SELECT json_remove(value_json,'$.output') AS value_json,substr(output,1,200) AS summary FROM app_module_owner_work_items ${where} ORDER BY created_at DESC,id DESC LIMIT 20 OFFSET ?`)
      .all(...args, page * 20).map(row => ({ ...JSON.parse(row.value_json), summary: row.summary }));
    const templates = db().prepare("SELECT template_id AS id,template_name AS name FROM app_module_owner_work_items GROUP BY template_id ORDER BY template_name").all();
    const owners = db().prepare("SELECT owner_id AS id,owner_name AS name,template_id AS templateId FROM app_module_owner_work_items GROUP BY owner_id,template_id ORDER BY owner_name").all();
    return { records, total, templates, owners };
  }
  function getWorkItemAttempt(workItemId, id) {
    const row = db().prepare("SELECT value_json FROM app_module_owner_work_item_attempts WHERE work_item_id=? AND id=?").get(workItemId, id);
    if (!row) throw new Error("执行记录不存在或不属于此任务。");
    return JSON.parse(row.value_json);
  }
  function writeAttempt(value) {
    db().prepare(`INSERT INTO app_module_owner_work_item_attempts(id,work_item_id,status,started_at,value_json) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,value_json=excluded.value_json`)
      .run(value.id, value.workItemId, value.status, value.startedAt, JSON.stringify(value));
  }
  function startWorkItemAttempt(id, version, input, configuration) {
    return transaction(() => {
      const item = getWorkItem(id);
      if (item.version !== version) throw new Error("任务已变更，请刷新后重试。");
      if (ACTIVE.includes(item.status) || item.status === "void") throw new Error("任务正在执行、待核对或已作废，不能重复执行。");
      const attempt = { id: randomUUID(), workItemId: id, status: "creating", startedAt: Date.now(), input, configuration, output: "", error: "" };
      writeAttempt(attempt);
      writeItem({ ...item, status: "creating", version: item.version + 1, latestAttemptId: attempt.id, lastStartedAt: attempt.startedAt, updatedAt: Date.now() });
      return attempt;
    });
  }
  function updateWorkItemAttempt(workItemId, id, patch) {
    return transaction(() => {
      const attempt = getWorkItemAttempt(workItemId, id);
      if (!ACTIVE.includes(attempt.status)) return attempt;
      const updated = { ...attempt, ...patch };
      if (JSON.stringify(updated) === JSON.stringify(attempt)) return attempt;
      writeAttempt(updated);
      const item = getWorkItem(workItemId);
      if (item.latestAttemptId === id && item.status !== "void") writeItem({ ...item, status: updated.status, sessionId: updated.sessionId,
        error: updated.error, version: item.version + 1, updatedAt: Date.now() });
      return updated;
    });
  }
  function changeWorkItem(id, version, operation, reason = "") {
    return transaction(() => {
      const item = getWorkItem(id);
      if (item.version !== version) throw new Error("任务已变更，请刷新后重试。");
      if (ACTIVE.includes(item.status)) throw new Error("活动任务或待核对任务不能作废／恢复。");
      if (operation === "restore" && item.status !== "void") throw new Error("仅已作废任务可以恢复。");
      if (operation === "void" && item.status === "void") throw new Error("任务已作废。");
      return writeItem({ ...item, status: operation === "restore" ? "pending" : "void", voidReason: operation === "void" ? reason : "",
        voidedAt: operation === "void" ? Date.now() : null, version: item.version + 1, updatedAt: Date.now() });
    });
  }
  function listWorkItemAttempts(id, page = 0) {
    getWorkItem(id);
    const total = db().prepare("SELECT COUNT(*) AS count FROM app_module_owner_work_item_attempts WHERE work_item_id=?").get(id).count;
    const records = db().prepare("SELECT json_remove(value_json,'$.input','$.output','$.configuration') AS value_json FROM app_module_owner_work_item_attempts WHERE work_item_id=? ORDER BY started_at DESC,id DESC LIMIT 20 OFFSET ?")
      .all(id, page * 20).map(row => JSON.parse(row.value_json));
    return { records, total };
  }
  function recoverWorkItemAttempts() {
    const rows = db().prepare("SELECT value_json FROM app_module_owner_work_item_attempts WHERE status IN ('creating','running','uncertain')").all();
    for (const row of rows) {
      const value = JSON.parse(row.value_json);
      updateWorkItemAttempt(value.workItemId, value.id, { status: "uncertain", error: "应用重启，执行结果待核对；确认原会话已结束或不存在后再重试。", recovered: true });
    }
  }
  function workItemOwnerBusy(templateId, ownerId) {
    return Boolean(db().prepare("SELECT 1 FROM app_module_owner_work_items WHERE template_id=? AND owner_id=? AND status IN ('creating','running','uncertain') LIMIT 1").get(templateId, ownerId));
  }
  return { initializeWorkItems, insertWorkItem, getWorkItem, listWorkItems, getWorkItemAttempt, startWorkItemAttempt,
    updateWorkItemAttempt, changeWorkItem, listWorkItemAttempts, recoverWorkItemAttempts, workItemOwnerBusy };
}
module.exports = { createWorkItemStore };
