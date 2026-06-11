import { HardDrive, MemoryStick, Network } from "lucide-react";
import type { RemoteSystemMetrics } from "../vite-env";

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
  if (state.status === "hidden") return null;

  if (state.status === "loading" || state.status === "error") {
    return (
      <div className={`remote-system-status ${state.status}`} role="status">
        <Network aria-hidden="true" />
        <span>{state.status === "loading" ? "正在读取服务器状态..." : "服务器监控不可用"}</span>
      </div>
    );
  }

  const { network, memory, disk } = state.metrics;
  const memoryPercent = formatPercent(memory.usedBytes, memory.totalBytes);

  return (
    <div className="remote-system-status" aria-label="SSH server metrics">
      <span
        className="remote-system-metric"
        title={`网络：下载 ${formatRate(network.receivedBytesPerSecond)}，上传 ${formatRate(network.transmittedBytesPerSecond)}`}
      >
        <Network aria-hidden="true" />
        <span>↓ {formatRate(network.receivedBytesPerSecond)}</span>
        <span>↑ {formatRate(network.transmittedBytesPerSecond)}</span>
      </span>
      <span
        className="remote-system-metric"
        title={disk ? `磁盘 ${disk.mountPoint}：已用 ${disk.usedPercent}%，剩余 ${formatBytes(disk.availableBytes)}` : "未找到磁盘指标"}
      >
        <HardDrive aria-hidden="true" />
        <span>{disk ? `${disk.mountPoint} ${disk.usedPercent}%` : "磁盘 --"}</span>
        {disk && <span className="remote-system-detail">余 {formatBytes(disk.availableBytes)}</span>}
      </span>
      <span
        className="remote-system-metric"
        title={`内存：已用 ${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}（${memoryPercent}）`}
      >
        <MemoryStick aria-hidden="true" />
        <span>{memoryPercent}</span>
        <span className="remote-system-detail">{formatBytes(memory.usedBytes)} / {formatBytes(memory.totalBytes)}</span>
      </span>
    </div>
  );
}
