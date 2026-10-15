const DAY_MS = 86400000;
const BEIJING_OFFSET_MS = 8 * 3600000;

function beijingDay(timestamp) {
  return new Date(timestamp + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function customDateRange({ startDate, endDate }) {
  const valid = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid(startDate) || !valid(endDate) || startDate > endDate) {
    throw new Error("Invalid statistics date range (YYYY-MM-DD).");
  }
  return { startDate, endDate,
    startAt: Date.parse(`${startDate}T00:00:00+08:00`),
    endAt: Date.parse(`${endDate}T00:00:00+08:00`) + DAY_MS };
}

module.exports = { beijingDay, customDateRange };
