import { useState, type MouseEvent } from "react";
import type { RemoteSystemMetricPoint } from "../../hooks/useRemoteSystemMetrics";
import { useI18n } from "../../i18n";

const WIDTH = 320;
const HEIGHT = 104;
const PLOT_TOP = 8;
const PLOT_BOTTOM = 82;
const PLOT_LEFT = 8;
const PLOT_RIGHT = 312;
const MAX_CONTIGUOUS_INTERVAL_MS = 7500;

type PlotRange = { start: number; end: number; duration: number };
type PlotPoint = { x: number; y: number };

function validMetric(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function formatPercent(value: number | null, locale: string) {
  return validMetric(value)
    ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`
    : "--";
}

function formatBytes(value: number, locale: string) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const maximumFractionDigits = size >= 100 || index === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits }).format(size)} ${units[index]}`;
}

function formatRate(value: number | null, locale: string) {
  return validMetric(value) ? `${formatBytes(value, locale)}/s` : "--";
}

function getPlotRange(points: RemoteSystemMetricPoint[]): PlotRange | undefined {
  if (points.length === 0) return undefined;
  const end = points[points.length - 1].sampledAt;
  const start = Math.min(points[0].sampledAt, end - 3000);
  return { start, end, duration: Math.max(1, end - start) };
}

function getX(sampledAt: number, range: PlotRange) {
  return PLOT_LEFT + (sampledAt - range.start) / range.duration * (PLOT_RIGHT - PLOT_LEFT);
}

function createSegments(
  points: RemoteSystemMetricPoint[],
  getValue: (point: RemoteSystemMetricPoint) => number | null,
  maximum: number,
  range: PlotRange | undefined
) {
  if (!range) return [];
  const segments: PlotPoint[][] = [];
  let segment: PlotPoint[] = [];
  let previousTime: number | undefined;

  points.forEach((point) => {
    const value = getValue(point);
    if (!validMetric(value) || (previousTime !== undefined && point.sampledAt - previousTime > MAX_CONTIGUOUS_INTERVAL_MS)) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
    }
    if (validMetric(value)) {
      segment.push({
        x: getX(point.sampledAt, range),
        y: PLOT_BOTTOM - Math.min(maximum, value) / maximum * (PLOT_BOTTOM - PLOT_TOP)
      });
    }
    previousTime = point.sampledAt;
  });
  if (segment.length > 0) segments.push(segment);
  return segments;
}

function renderSegments(segments: PlotPoint[][], className: string) {
  return segments.map((segment, index) => segment.length === 1
    ? <circle key={index} className={className} cx={segment[0].x} cy={segment[0].y} r="2.5" vectorEffect="non-scaling-stroke" />
    : <polyline
        key={index}
        className={className}
        points={segment.map((point) => `${point.x},${point.y}`).join(" ")}
        vectorEffect="non-scaling-stroke"
      />);
}

function findNearestPointIndex(points: RemoteSystemMetricPoint[], event: MouseEvent<SVGSVGElement>) {
  const range = getPlotRange(points);
  const bounds = event.currentTarget.getBoundingClientRect();
  if (!range || bounds.width <= 0) return undefined;
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  const targetTime = range.start + ratio * range.duration;
  let nearestIndex = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (Math.abs(points[index].sampledAt - targetTime) < Math.abs(points[nearestIndex].sampledAt - targetTime)) {
      nearestIndex = index;
    }
  }
  return nearestIndex;
}

function tooltipPosition(point: RemoteSystemMetricPoint, range: PlotRange) {
  const percent = getX(point.sampledAt, range) / WIDTH * 100;
  return {
    left: `${percent}%`,
    alignment: percent < 25 ? "start" : percent > 75 ? "end" : "center"
  };
}

function ChartGrid({ maximum }: { maximum: number }) {
  return <>{[0, maximum / 2, maximum].map((value) => {
    const y = PLOT_BOTTOM - value / maximum * (PLOT_BOTTOM - PLOT_TOP);
    return <line key={value} className="remote-metric-grid" x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={y} y2={y} />;
  })}</>;
}

export function RemoteMetricChart({ points, metric, currentValue, getValue, tone }: {
  points: RemoteSystemMetricPoint[];
  metric: string;
  currentValue: number | null;
  getValue: (point: RemoteSystemMetricPoint) => number | null;
  tone: "cpu" | "memory";
}) {
  const { locale, t } = useI18n();
  const [hoveredIndex, setHoveredIndex] = useState<number>();
  const range = getPlotRange(points);
  const segments = createSegments(points, getValue, 100, range);
  const validPointCount = segments.reduce((count, segment) => count + segment.length, 0);
  const firstTime = points[0]?.sampledAt;
  const lastTime = points[points.length - 1]?.sampledAt;
  const hoveredPoint = hoveredIndex === undefined ? undefined : points[hoveredIndex];
  const hoveredValue = hoveredPoint ? getValue(hoveredPoint) : null;
  const timeFormatter = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const position = hoveredPoint && range ? tooltipPosition(hoveredPoint, range) : undefined;

  return (
    <figure className={`remote-metric-chart ${tone}`} onMouseLeave={() => setHoveredIndex(undefined)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t("system.historyChart", { metric, percent: formatPercent(currentValue, locale) })}
        onMouseMove={(event) => setHoveredIndex(findNearestPointIndex(points, event))}
      >
        <title>{t("system.historyChart", { metric, percent: formatPercent(currentValue, locale) })}</title>
        <ChartGrid maximum={100} />
        {renderSegments(segments, "remote-metric-line")}
        {hoveredPoint && range && validMetric(hoveredValue) && <>
          <line className="remote-metric-cursor" x1={getX(hoveredPoint.sampledAt, range)} x2={getX(hoveredPoint.sampledAt, range)} y1={PLOT_TOP} y2={PLOT_BOTTOM} />
          <circle className="remote-metric-marker" cx={getX(hoveredPoint.sampledAt, range)} cy={PLOT_BOTTOM - Math.min(100, hoveredValue) / 100 * (PLOT_BOTTOM - PLOT_TOP)} r="3" vectorEffect="non-scaling-stroke" />
        </>}
      </svg>
      {validPointCount === 0 && <span className="remote-metric-empty">{t("system.collectingHistory")}</span>}
      {hoveredPoint && position && <div className={`remote-metric-tooltip ${position.alignment}`} style={{ left: position.left }} role="status">
        <time>{timeFormatter.format(hoveredPoint.sampledAt)}</time>
        <strong>{metric} {formatPercent(hoveredValue, locale)}</strong>
      </div>}
      <figcaption>
        <span>{firstTime === undefined ? "--" : timeFormatter.format(firstTime)}</span>
        <span>0–100%</span>
        <span>{lastTime === undefined ? "--" : timeFormatter.format(lastTime)}</span>
      </figcaption>
    </figure>
  );
}

export function RemoteNetworkChart({ points, received, transmitted }: {
  points: RemoteSystemMetricPoint[];
  received: number | null;
  transmitted: number | null;
}) {
  const { locale, t } = useI18n();
  const [hoveredIndex, setHoveredIndex] = useState<number>();
  const range = getPlotRange(points);
  const maximum = Math.max(1, ...points.flatMap((point) => [point.receivedBytesPerSecond, point.transmittedBytesPerSecond]).filter(validMetric));
  const receivedSegments = createSegments(points, (point) => point.receivedBytesPerSecond, maximum, range);
  const transmittedSegments = createSegments(points, (point) => point.transmittedBytesPerSecond, maximum, range);
  const validPointCount = [...receivedSegments, ...transmittedSegments].reduce((count, segment) => count + segment.length, 0);
  const firstTime = points[0]?.sampledAt;
  const lastTime = points[points.length - 1]?.sampledAt;
  const hoveredPoint = hoveredIndex === undefined ? undefined : points[hoveredIndex];
  const timeFormatter = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const position = hoveredPoint && range ? tooltipPosition(hoveredPoint, range) : undefined;
  const hoveredX = hoveredPoint && range ? getX(hoveredPoint.sampledAt, range) : undefined;

  return (
    <figure className="remote-metric-chart network" onMouseLeave={() => setHoveredIndex(undefined)}>
      <div className="remote-network-legend" aria-hidden="true">
        <span className="download">{t("system.download")}</span>
        <span className="upload">{t("system.upload")}</span>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t("system.networkHistoryChart", { download: formatRate(received, locale), upload: formatRate(transmitted, locale) })}
        onMouseMove={(event) => setHoveredIndex(findNearestPointIndex(points, event))}
      >
        <title>{t("system.networkHistoryChart", { download: formatRate(received, locale), upload: formatRate(transmitted, locale) })}</title>
        <ChartGrid maximum={maximum} />
        {renderSegments(receivedSegments, "remote-metric-line download")}
        {renderSegments(transmittedSegments, "remote-metric-line upload")}
        {hoveredX !== undefined && <line className="remote-metric-cursor" x1={hoveredX} x2={hoveredX} y1={PLOT_TOP} y2={PLOT_BOTTOM} />}
        {hoveredPoint && validMetric(hoveredPoint.receivedBytesPerSecond) && <circle
          className="remote-metric-marker download" cx={hoveredX} r="3" vectorEffect="non-scaling-stroke"
          cy={PLOT_BOTTOM - Math.min(maximum, hoveredPoint.receivedBytesPerSecond) / maximum * (PLOT_BOTTOM - PLOT_TOP)}
        />}
        {hoveredPoint && validMetric(hoveredPoint.transmittedBytesPerSecond) && <circle
          className="remote-metric-marker upload" cx={hoveredX} r="3" vectorEffect="non-scaling-stroke"
          cy={PLOT_BOTTOM - Math.min(maximum, hoveredPoint.transmittedBytesPerSecond) / maximum * (PLOT_BOTTOM - PLOT_TOP)}
        />}
      </svg>
      {validPointCount === 0 && <span className="remote-metric-empty">{t("system.collectingHistory")}</span>}
      {hoveredPoint && position && <div className={`remote-metric-tooltip ${position.alignment}`} style={{ left: position.left }} role="status">
        <time>{timeFormatter.format(hoveredPoint.sampledAt)}</time>
        <strong className="download">↓ {formatRate(hoveredPoint.receivedBytesPerSecond, locale)}</strong>
        <strong className="upload">↑ {formatRate(hoveredPoint.transmittedBytesPerSecond, locale)}</strong>
      </div>}
      <figcaption>
        <span>{firstTime === undefined ? "--" : timeFormatter.format(firstTime)}</span>
        <span>0–{formatRate(maximum, locale)}</span>
        <span>{lastTime === undefined ? "--" : timeFormatter.format(lastTime)}</span>
      </figcaption>
    </figure>
  );
}
