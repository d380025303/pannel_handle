import type { RemoteSystemMetricPoint } from "../../hooks/useRemoteSystemMetrics";
import { useI18n } from "../../i18n";

const WIDTH = 320;
const HEIGHT = 104;
const PLOT_TOP = 8;
const PLOT_BOTTOM = 82;
const PLOT_LEFT = 8;
const PLOT_RIGHT = 312;
const MAX_CONTIGUOUS_INTERVAL_MS = 7500;

function validPercent(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function formatPercent(value: number | null) {
  return validPercent(value) ? `${Math.round(value)}%` : "--";
}

function createSegments(
  points: RemoteSystemMetricPoint[],
  getValue: (point: RemoteSystemMetricPoint) => number | null
) {
  if (points.length === 0) return [];
  const end = points[points.length - 1].sampledAt;
  const start = Math.min(points[0].sampledAt, end - 3000);
  const duration = Math.max(1, end - start);
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let segment: Array<{ x: number; y: number }> = [];
  let previousTime: number | undefined;

  for (const point of points) {
    const value = getValue(point);
    if (!validPercent(value) || (previousTime !== undefined && point.sampledAt - previousTime > MAX_CONTIGUOUS_INTERVAL_MS)) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
    }
    if (validPercent(value)) {
      segment.push({
        x: PLOT_LEFT + (point.sampledAt - start) / duration * (PLOT_RIGHT - PLOT_LEFT),
        y: PLOT_BOTTOM - Math.min(100, value) / 100 * (PLOT_BOTTOM - PLOT_TOP)
      });
    }
    previousTime = point.sampledAt;
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

export function RemoteMetricChart({ points, metric, currentValue, getValue, tone }: {
  points: RemoteSystemMetricPoint[];
  metric: string;
  currentValue: number | null;
  getValue: (point: RemoteSystemMetricPoint) => number | null;
  tone: "cpu" | "memory";
}) {
  const { locale, t } = useI18n();
  const segments = createSegments(points, getValue);
  const validPointCount = segments.reduce((count, segment) => count + segment.length, 0);
  const firstTime = points[0]?.sampledAt;
  const lastTime = points[points.length - 1]?.sampledAt;
  const timeFormatter = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <figure className={`remote-metric-chart ${tone}`}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t("system.historyChart", { metric, percent: formatPercent(currentValue) })}
      >
        <title>{t("system.historyChart", { metric, percent: formatPercent(currentValue) })}</title>
        {[0, 50, 100].map((value) => {
          const y = PLOT_BOTTOM - value / 100 * (PLOT_BOTTOM - PLOT_TOP);
          return <line key={value} className="remote-metric-grid" x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={y} y2={y} />;
        })}
        {segments.map((segment, index) => segment.length === 1
          ? <circle key={index} className="remote-metric-line" cx={segment[0].x} cy={segment[0].y} r="2.5" vectorEffect="non-scaling-stroke" />
          : <polyline
              key={index}
              className="remote-metric-line"
              points={segment.map((point) => `${point.x},${point.y}`).join(" ")}
              vectorEffect="non-scaling-stroke"
            />)}
      </svg>
      {validPointCount === 0 && <span className="remote-metric-empty">{t("system.collectingHistory")}</span>}
      <figcaption>
        <span>{firstTime === undefined ? "--" : timeFormatter.format(firstTime)}</span>
        <span>0–100%</span>
        <span>{lastTime === undefined ? "--" : timeFormatter.format(lastTime)}</span>
      </figcaption>
    </figure>
  );
}
