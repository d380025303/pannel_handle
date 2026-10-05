const unwrap = value => value && Object.hasOwn(value, "data") ? value.data : value;

function createScheduledTasksService(contextFor) {
  async function call(context, method, taskId, body) {
    context.assertCurrent();
    const value = unwrap(await context.transport.scheduledTasksRequest(method, context.threadId, taskId, body));
    context.assertCurrent();
    if (value?.error) throw new Error(value.error.message || "CodeBuddy 定时任务操作失败。");
    return value;
  }
  async function list(context) {
    const value = await call(context, "GET");
    if (!Array.isArray(value?.tasks)) throw new Error("CodeBuddy 定时任务列表格式无效。");
    return value.tasks.filter(task => task && typeof task.id === "string" && typeof task.prompt === "string" && typeof task.cron === "string")
      .map(task => ({ id: task.id, prompt: task.prompt, cron: task.cron, recurring: task.recurring === true,
        durable: task.durable === true, enabled: task.enabled !== false,
        ...(Number.isFinite(task.createdAt) ? { createdAt: task.createdAt } : {}),
        ...(Number.isFinite(task.lastFiredAt) ? { lastFiredAt: task.lastFiredAt } : {}) }));
  }
  return {
    list: (id, threadId) => list(contextFor(id, threadId)),
    async create(id, threadId, input) {
      const context = contextFor(id, threadId);
      if (typeof input?.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 16000)
        throw new Error("任务内容不能为空且不能超过 16000 字符。");
      if (typeof input.cron !== "string" || input.cron.length > 200 || input.cron.trim().split(/\s+/).length !== 5)
        throw new Error("请输入五段 Cron 表达式。");
      if (typeof input.recurring !== "boolean" || typeof input.durable !== "boolean") throw new Error("定时任务选项无效。");
      await call(context, "POST", null, { prompt: input.prompt.trim(), cron: input.cron.trim(), recurring: input.recurring, durable: input.durable });
    },
    async delete(id, threadId, taskId) {
      const context = contextFor(id, threadId);
      if (typeof taskId !== "string" || !taskId || taskId.length > 200) throw new Error("定时任务 ID 无效。");
      if (!(await list(context)).some(task => task.id === taskId)) throw new Error("定时任务不属于当前对话或已不存在。");
      await call(context, "DELETE", taskId);
    }
  };
}
module.exports = { createScheduledTasksService };
