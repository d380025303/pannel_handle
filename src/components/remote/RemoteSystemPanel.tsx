import { Cpu, HardDrive, MemoryStick, Network } from "lucide-react";
import { useI18n } from "../../i18n";
import type { RemoteSystemMetricsState } from "../../hooks/useRemoteSystemMetrics";
import { RemoteMetricChart } from "./RemoteMetricChart";

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 100 || index === 0 ? 0 : size >= 10 ? 1 : 2)} ${units[index]}`;
}

function validPercent(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function formatPercent(value: number | null) {
  return validPercent(value) ? `${Math.round(value)}%` : "--";
}

function formatRate(value: number | null) {
  return value === null || !Number.isFinite(value) || value < 0 ? "--" : `${formatBytes(value)}/s`;
}

function UsageBar({ value, label }: { value: number | null; label: string }) {
  if (!validPercent(value)) return null;
  return <progress aria-label={label} max={100} value={Math.min(100, value)} />;
}

export function RemoteSystemPanel({ state, sessionTitle, preferredDiskMountPoint, onSelectDisk }: {
  state: RemoteSystemMetricsState;
  sessionTitle: string;
  preferredDiskMountPoint?: string;
  onSelectDisk: (mountPoint: string) => void;
}) {
  const { locale, t } = useI18n();
  if (state.status === "hidden") return null;
  const metrics = state.status === "ready" ? state.metrics : undefined;
  const history = state.status === "ready" ? state.history : [];
  const disk = metrics?.disks.find((item) => item.mountPoint === preferredDiskMountPoint) ?? metrics?.disks[0];
  const memoryPercent = metrics && Number.isFinite(metrics.memory.usedBytes) && metrics.memory.usedBytes >= 0
    && Number.isFinite(metrics.memory.totalBytes) && metrics.memory.totalBytes > 0
    ? metrics.memory.usedBytes / metrics.memory.totalBytes * 100 : null;

  return (
    <section className="remote-system-panel" aria-label={t("system.metrics")}>
      <header className="remote-system-panel-heading">
        <strong>{t("system.metrics")}</strong>
        <span>{sessionTitle}</span>
        {metrics && <small>{t("system.sampledAt", { time: new Date(metrics.sampledAt).toLocaleTimeString(locale) })}</small>}
      </header>
      {!metrics ? <p className={`remote-system-panel-message ${state.status}`} role="status">
        {t(state.status === "loading" ? "system.loading" : "system.unavailable")}
      </p> : <>
        <section className="remote-system-card" aria-label="CPU">
          <h3><Cpu aria-hidden="true" />CPU<strong>{formatPercent(metrics.cpu.usedPercent)}</strong></h3>
          <RemoteMetricChart
            points={history}
            metric="CPU"
            currentValue={metrics.cpu.usedPercent}
            getValue={(point) => point.cpuUsedPercent}
            tone="cpu"
          />
        </section>
        <section className="remote-system-card" aria-label={t("system.memory")}>
          <h3><MemoryStick aria-hidden="true" />{t("system.memory")}<strong>{formatPercent(memoryPercent)}</strong></h3>
          <RemoteMetricChart
            points={history}
            metric={t("system.memory")}
            currentValue={memoryPercent}
            getValue={(point) => point.memoryUsedPercent}
            tone="memory"
          />
          <p>{formatBytes(metrics.memory.usedBytes)} / {formatBytes(metrics.memory.totalBytes)}</p>
        </section>
        <section className="remote-system-card" aria-label={t("system.network")}>
          <h3><Network aria-hidden="true" />{t("system.network")}</h3>
          <dl>
            <dt>{t("system.download")}</dt><dd>↓ {formatRate(metrics.network.receivedBytesPerSecond)}</dd>
            <dt>{t("system.upload")}</dt><dd>↑ {formatRate(metrics.network.transmittedBytesPerSecond)}</dd>
          </dl>
        </section>
        <section className="remote-system-card" aria-label={t("system.disk")}>
          <h3><HardDrive aria-hidden="true" />{t("system.disk")}{disk && <strong>{formatPercent(disk.usedPercent)}</strong>}</h3>
          <select
            aria-label={disk ? t("system.diskSelect", { mountPoint: disk.mountPoint }) : t("system.diskMissing")}
            value={disk?.mountPoint ?? ""}
            disabled={!disk}
            onChange={(event) => onSelectDisk(event.target.value)}
          >
            {!disk && <option value="">{t("system.diskMissing")}</option>}
            {metrics.disks.map((item) => <option key={`${item.filesystem}:${item.mountPoint}`} value={item.mountPoint}>
              {item.mountPoint} · {formatPercent(item.usedPercent)}
            </option>)}
          </select>
          {disk && <>
            <UsageBar label={t("system.disk")} value={disk.usedPercent} />
            <p>{disk.filesystem} · {disk.type}</p>
            <p>{t("system.diskUsage", { used: formatBytes(disk.usedBytes), total: formatBytes(disk.totalBytes), available: formatBytes(disk.availableBytes) })}</p>
            <dl>
              <dt>{t("system.ioBusy")}</dt><dd>{formatPercent(disk.io.busyPercent)}</dd>
              <dt>{t("system.read")}</dt><dd>{formatRate(disk.io.readBytesPerSecond)}</dd>
              <dt>{t("system.write")}</dt><dd>{formatRate(disk.io.writeBytesPerSecond)}</dd>
            </dl>
          </>}
        </section>
      </>}
    </section>
  );
}
