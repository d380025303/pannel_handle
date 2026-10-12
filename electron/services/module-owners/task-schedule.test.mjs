import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
const { nextRun, parseCron, taskSchema } = createRequire(import.meta.url)("./task-schedule.cjs");
describe("module owner schedule", () => {
  it("computes local cron lists, ranges, steps, Sunday aliases and day OR semantics", () => {
    const at = new Date(2026, 9, 12, 8, 7).getTime();
    expect(new Date(nextRun({ kind: "cron", cron: "10,20-40/10 8 * * *" }, at)).getMinutes()).toBe(10);
    expect(new Date(nextRun({ kind: "cron", cron: "0 9 * * 7" }, at)).getDay()).toBe(0);
    expect(new Date(nextRun({ kind: "cron", cron: "0 9 15 * 1" }, at)).getDate()).toBe(12);
    expect(new Date(nextRun({ kind: "cron", cron: "0 9 15 * *" }, at)).getDate()).toBe(15);
    expect(nextRun({ kind: "interval", minutes: 30 }, at)).toBe(at + 1800000);
  });
  it("keeps wildcard steps subject to both day and weekday matches", () => {
    const at = new Date(2026, 9, 12, 10).getTime();
    for (const cron of ["0 9 */1 * 1", "0 9 * * 1", "0 9 */2 * 1"]) {
      expect(nextRun({ kind: "cron", cron }, at)).toBe(new Date(2026, 9, 19, 9).getTime());
    }
    for (const cron of ["0 9 15 * */1", "0 9 15 * *", "0 9 15 * */2"]) {
      expect(nextRun({ kind: "cron", cron }, at)).toBe(new Date(2026, 9, 15, 9).getTime());
    }
    expect(nextRun({ kind: "cron", cron: "0 9 */2 * */2" }, at)).toBe(new Date(2026, 9, 13, 9).getTime());
    expect(nextRun({ kind: "cron", cron: "0 9 */2 * 1" }, new Date(2026, 9, 19, 10).getTime())).toBe(new Date(2026, 10, 9, 9).getTime());
    expect(nextRun({ kind: "cron", cron: "0 9 15 * 1" }, at)).toBe(new Date(2026, 9, 15, 9).getTime());
    expect(parseCron("0 9 */1 * */2").map(field => field.wildcard)).toEqual([false, false, true, true, true]);
  });
  it("handles leap days and rejects invalid or impossible schedules", () => {
    expect(new Date(nextRun({ kind: "cron", cron: "0 0 29 2 *" }, new Date(2026, 0, 1).getTime())).getFullYear()).toBe(2028);
    for (const cron of ["* * *", "60 * * * *", "*/0 * * * *", "1-0 * * * *", "* * * JAN *"]) expect(() => parseCron(cron)).toThrow();
    expect(() => nextRun({ kind: "cron", cron: "0 0 31 2 *" }, Date.now())).toThrow("没有可执行时间");
    expect(() => taskSchema.parse({ ownerId: "one", name: "task", prompt: "x", mode: "default", enabled: true, tools: [], schedule: { kind: "interval", minutes: 0, count: 1 } })).toThrow();
  });
});
