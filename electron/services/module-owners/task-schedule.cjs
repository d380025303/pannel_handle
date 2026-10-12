const { z } = require("zod");

const taskSchema = z.object({
  id: z.string().min(1).optional(), ownerId: z.string().min(1),
  name: z.string().trim().min(1).max(200), prompt: z.string().trim().min(1).max(100000),
  promptTemplateId: z.string().min(1).optional(),
  mode: z.enum(["default", "plan"]), enabled: z.boolean(), recordHistory: z.boolean().default(false),
  tools: z.array(z.enum(["list_module_owners", "update_module_owner"])).max(2).refine(v => new Set(v).size === v.length),
  schedule: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("cron"), cron: z.string().trim().min(1).max(200) }).strict(),
    z.object({ kind: z.literal("interval"), minutes: z.number().int().min(1).max(525600), count: z.number().int().positive().max(1000000) }).strict()
  ])
}).strict();

function parseCron(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron 必须为五段：分钟 小时 日 月 星期。");
  return fields.map((field, index) => {
    const [min, max] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]][index];
    const values = new Set();
    for (const part of field.split(",")) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match) throw new Error("Cron 仅支持数字、*、范围、列表和步长。");
      const step = Number(match[2] || 1);
      const range = match[1] === "*" ? [min, max] : match[1].split("-").map(Number);
      const start = range[0]; const end = range[1] ?? (match[2] ? max : start);
      if (step < 1 || start < min || end > max || start > end) throw new Error("Cron 数值超出范围。");
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return { values, wildcard: /^\*(?:\/\d+)?$/.test(field) };
  });
}

function nextRun(schedule, now) {
  if (schedule.kind === "interval") return now + schedule.minutes * 60000;
  const fields = parseCron(schedule.cron);
  const date = new Date(now); date.setSeconds(0, 0); date.setMinutes(date.getMinutes() + 1);
  // Jump across nonmatching months/days/hours rather than scanning years minute by minute.
  const limit = date.getFullYear() + 8;
  while (date.getFullYear() < limit) {
    if (!fields[3].values.has(date.getMonth() + 1)) { date.setDate(1); date.setMonth(date.getMonth() + 1); date.setHours(0, 0, 0, 0); continue; }
    const dom = fields[2].values.has(date.getDate()); const dow = fields[4].values.has(date.getDay());
    const day = fields[2].wildcard || fields[4].wildcard ? dom && dow : dom || dow;
    if (!day) { date.setDate(date.getDate() + 1); date.setHours(0, 0, 0, 0); continue; }
    if (!fields[1].values.has(date.getHours())) { date.setHours(date.getHours() + 1, 0, 0, 0); continue; }
    if (!fields[0].values.has(date.getMinutes())) { date.setMinutes(date.getMinutes() + 1); continue; }
    return date.getTime();
  }
  throw new Error("Cron 在未来八年内没有可执行时间。");
}
module.exports = { taskSchema, parseCron, nextRun };
