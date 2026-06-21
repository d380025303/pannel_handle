import { HardDrive, MemoryStick, Network } from "lucide-react";
import { useI18n } from "../../i18n";
import type { RemoteSystemMetrics } from "../../vite-env";

type RemoteSystemStatusProps = {
  state:
    | { status: "hidden" }
    | { status: "loading" }
    | { status: "ready"; metrics: RemoteSystemMetrics }
    | { status: "error" };
};

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[unitIndex]}`;
}

function formatRate(value: number | null) {
  return value === null ? "--" : `${formatBytes(value)}/s`;
}

function formatPercent(used: number, total: number) {
  return total > 0 ? `${Math.round((used / total) * 100)}%` : "--";
}

export function RemoteSystemStatus({ state }: RemoteSystemStatusProps) {
  const { t } = useI18n();

  if (state.status === "hidden") return null;

  if (state.status === "loading" || state.status === "error") {
    return (
      <div className={`remote-system-status ${state.status}`} role="status">
        <Network aria-hidden="true" />
        <span>{state.status === "loading" ? t("system.loading") : t("system.unavailable")}</span>
      </div>
    );
  }

  const { network, memory, disk } = state.metrics;
  const memoryPercent = formatPercent(memory.usedBytes, memory.totalBytes);

  return (
    <div className="remote-system-status" aria-label={t("system.metrics")}>
      <span
        className="remote-system-metric"
        title={t("system.networkTitle", {
          download: formatRate(network.receivedBytesPerSecond),
          upload: formatRate(network.transmittedBytesPerSecond)
        })}
      >
        <Network aria-hidden="true" />
        <span>↓ {formatRate(network.receivedBytesPerSecond)}</span>
        <span>↑ {formatRate(network.transmittedBytesPerSecond)}</span>
      </span>
      <span
        className="remote-system-metric"
        title={disk
          ? t("system.diskTitle", {
            mountPoint: disk.mountPoint,
            usedPercent: disk.usedPercent,
            available: formatBytes(disk.availableBytes)
          })
          : t("system.diskMissing")}
      >
        <HardDrive aria-hidden="true" />
        <span>{disk ? `${disk.mountPoint} ${disk.usedPercent}%` : t("system.diskLabel")}</span>
        {disk && <span className="remote-system-detail">{t("system.diskRemaining", { available: formatBytes(disk.availableBytes) })}</span>}
      </span>
      <span
        className="remote-system-metric"
        title={t("system.memoryTitle", {
          used: formatBytes(memory.usedBytes),
          total: formatBytes(memory.totalBytes),
          percent: memoryPercent
        })}
      >
        <MemoryStick aria-hidden="true" />
        <span>{memoryPercent}</span>
        <span className="remote-system-detail">{formatBytes(memory.usedBytes)} / {formatBytes(memory.totalBytes)}</span>
      </span>
    </div>
  );
}
