import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Check, HardDrive, MemoryStick, Network } from "lucide-react";
import { useI18n } from "../../i18n";
import type { RemoteDiskMetrics, RemoteSystemMetrics } from "../../vite-env";

type RemoteSystemStatusProps = {
  state:
    | { status: "hidden" }
    | { status: "loading" }
    | { status: "ready"; metrics: RemoteSystemMetrics }
    | { status: "error" };
  preferredDiskMountPoint?: string;
  onSelectDisk: (mountPoint: string) => void;
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

function findDisplayedDisk(disks: RemoteDiskMetrics[], preferredDiskMountPoint?: string) {
  return disks.find((disk) => disk.mountPoint === preferredDiskMountPoint) ?? disks[0];
}

export function RemoteSystemStatus({ state, preferredDiskMountPoint, onSelectDisk }: RemoteSystemStatusProps) {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [diskListOpen, setDiskListOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});

  const disks = state.status === "ready" ? state.metrics.disks : [];
  const displayedDisk = useMemo(
    () => findDisplayedDisk(disks, preferredDiskMountPoint),
    [disks, preferredDiskMountPoint]
  );

  const closeDiskList = useCallback((restoreFocus = false) => {
    setDiskListOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = 8;
    const width = Math.min(380, window.innerWidth - viewportPadding * 2);
    const left = Math.min(
      Math.max(viewportPadding, rect.right - width),
      window.innerWidth - width - viewportPadding
    );
    setPopoverStyle({
      left,
      width,
      bottom: window.innerHeight - rect.top + gap,
      maxHeight: Math.max(140, rect.top - viewportPadding - gap)
    });
  }, []);

  useEffect(() => {
    if (!diskListOpen) return undefined;
    updatePopoverPosition();
    const handleViewportChange = () => updatePopoverPosition();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) closeDiskList();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDiskList(true);
      }
    };
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeDiskList, diskListOpen, updatePopoverPosition]);

  useEffect(() => {
    if (state.status !== "ready" || state.metrics.disks.length === 0) setDiskListOpen(false);
  }, [state]);

  if (state.status === "hidden") return null;

  if (state.status === "loading" || state.status === "error") {
    return (
      <div className={`remote-system-status ${state.status}`} role="status">
        <Network aria-hidden="true" />
        <span>{state.status === "loading" ? t("system.loading") : t("system.unavailable")}</span>
      </div>
    );
  }

  const { network, memory } = state.metrics;
  const memoryPercent = formatPercent(memory.usedBytes, memory.totalBytes);
  const diskTitle = displayedDisk
    ? t("system.diskTitle", {
      mountPoint: displayedDisk.mountPoint,
      usedPercent: displayedDisk.usedPercent,
      available: formatBytes(displayedDisk.availableBytes)
    })
    : t("system.diskMissing");

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
      <span className="remote-system-metric remote-system-disk">
        <button
          ref={triggerRef}
          className="remote-system-disk-trigger"
          type="button"
          aria-expanded={diskListOpen}
          aria-haspopup="listbox"
          aria-label={displayedDisk
            ? t("system.diskSelect", { mountPoint: displayedDisk.mountPoint })
            : t("system.diskMissing")}
          title={diskTitle}
          disabled={!displayedDisk}
          onClick={() => setDiskListOpen((open) => !open)}
        >
          <HardDrive aria-hidden="true" />
          <span>{displayedDisk ? `${displayedDisk.mountPoint} ${displayedDisk.usedPercent}%` : t("system.diskLabel")}</span>
          {displayedDisk && (
            <span className="remote-system-detail">
              {t("system.diskRemaining", { available: formatBytes(displayedDisk.availableBytes) })}
            </span>
          )}
        </button>
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

      {diskListOpen && createPortal(
        <div
          ref={popoverRef}
          className="remote-system-disk-popover"
          role="dialog"
          aria-label={t("system.diskListTitle")}
          style={popoverStyle}
        >
          <strong>{t("system.diskListTitle")}</strong>
          <div className="remote-system-disk-list" role="listbox" aria-label={t("system.diskListTitle")}>
            {disks.map((disk) => {
              const selected = disk.mountPoint === displayedDisk?.mountPoint;
              return (
                <button
                  className={selected ? "selected" : ""}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  key={`${disk.filesystem}:${disk.mountPoint}`}
                  onClick={() => {
                    onSelectDisk(disk.mountPoint);
                    closeDiskList(true);
                  }}
                >
                  <span className="remote-system-disk-row-heading">
                    <strong>{disk.mountPoint}</strong>
                    <span>{disk.usedPercent}%</span>
                    {selected && <Check aria-hidden="true" />}
                  </span>
                  <span className="remote-system-disk-progress" role="presentation">
                    <span style={{ width: `${Math.min(100, Math.max(0, disk.usedPercent))}%` }} />
                  </span>
                  <small>{disk.filesystem} · {disk.type}</small>
                  <small>
                    {t("system.diskUsage", {
                      used: formatBytes(disk.usedBytes),
                      total: formatBytes(disk.totalBytes),
                      available: formatBytes(disk.availableBytes)
                    })}
                  </small>
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
