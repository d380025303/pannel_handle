import { useEffect, useMemo, useState } from "react";
import { Bug, CircleAlert, Play, PlugZap, RefreshCw, RotateCw, Square } from "lucide-react";
import { useI18n } from "../../i18n";
import type { IdeaBridgeSnapshot, IdeaExecutionMode, IdeaRunConfiguration } from "../../vite-env";

const EMPTY_SNAPSHOT: IdeaBridgeSnapshot = { protocolVersion: 1, connections: [], updatedAt: 0 };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function ConfigurationCard({
  bridgeId,
  projectId,
  configuration,
  busy,
  runOperation
}: {
  bridgeId: string;
  projectId: string;
  configuration: IdeaRunConfiguration;
  busy: Set<string>;
  runOperation: (key: string, operation: () => Promise<unknown>) => void;
}) {
  const { t, locale } = useI18n();
  const configurationAvailable = configuration.supportsRun || configuration.supportsDebug;
  const hasActiveInstance = configuration.instances.some((instance) => instance.status !== "terminated");
  const parallelBlocked = hasActiveInstance && !configuration.allowParallel;
  const configBusy = busy.has(`configuration:${bridgeId}:${projectId}:${configuration.id}`);
  const start = (mode: IdeaExecutionMode) => runOperation(
    `configuration:${bridgeId}:${projectId}:${configuration.id}`,
    () => window.ideaBridgeApi.start(bridgeId, projectId, configuration.id, mode)
  );

  return (
    <section className="idea-configuration-card">
      <div className="idea-configuration-header">
        <div className="idea-configuration-title">
          <strong title={configuration.name}>{configuration.name}</strong>
          <span>{configuration.type}{configuration.temporary ? ` · ${t("idea.temporary")}` : ""}</span>
        </div>
        <div className="idea-configuration-actions">
          <button
            type="button"
            title={parallelBlocked ? t("idea.parallelBlocked") : t("idea.run")}
            aria-label={`${t("idea.run")} ${configuration.name}`}
            disabled={!configuration.supportsRun || parallelBlocked || configBusy}
            onClick={() => start("run")}
          >
            <Play aria-hidden="true" />
          </button>
          <button
            type="button"
            title={parallelBlocked ? t("idea.parallelBlocked") : t("idea.debug")}
            aria-label={`${t("idea.debug")} ${configuration.name}`}
            disabled={!configuration.supportsDebug || parallelBlocked || configBusy}
            onClick={() => start("debug")}
          >
            <Bug aria-hidden="true" />
          </button>
          {configurationAvailable && configuration.instances.length > 1 && (
            <button
              type="button"
              className="danger"
              title={t("idea.stopAll")}
              aria-label={`${t("idea.stopAll")} ${configuration.name}`}
              disabled={configBusy}
              onClick={() => runOperation(
                `configuration:${bridgeId}:${projectId}:${configuration.id}`,
                () => window.ideaBridgeApi.stopAll(bridgeId, projectId, configuration.id)
              )}
            >
              <Square aria-hidden="true" />
              <span>{t("idea.all")}</span>
            </button>
          )}
        </div>
      </div>
      {configuration.instances.length > 0 && (
        <div className="idea-instance-list">
          {configuration.instances.map((instance) => {
            const instanceBusy = busy.has(`instance:${bridgeId}:${instance.id}`);
            return (
              <div className="idea-instance-row" key={instance.id}>
                <span className={`idea-instance-mode ${instance.mode}`} title={instance.mode === "debug" ? t("idea.debug") : t("idea.run")}>
                  {instance.mode === "debug" ? <Bug aria-hidden="true" /> : <Play aria-hidden="true" />}
                </span>
                <div>
                  <strong>{instance.name}</strong>
                  <span>{t(`idea.status.${instance.status}`)} · {new Date(instance.startedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                </div>
                <button
                  type="button"
                  title={t("idea.restart")}
                  aria-label={`${t("idea.restart")} ${instance.name}`}
                  disabled={!configurationAvailable || instanceBusy || instance.status === "stopping"}
                  onClick={() => runOperation(`instance:${bridgeId}:${instance.id}`, () => window.ideaBridgeApi.restart(bridgeId, instance.id))}
                >
                  <RotateCw aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="danger"
                  title={t("idea.stop")}
                  aria-label={`${t("idea.stop")} ${instance.name}`}
                  disabled={instanceBusy || instance.status === "stopping"}
                  onClick={() => runOperation(`instance:${bridgeId}:${instance.id}`, () => window.ideaBridgeApi.stop(bridgeId, instance.id))}
                >
                  <Square aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function IdeaRunPanel() {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<IdeaBridgeSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busyKeys, setBusyKeys] = useState<string[]>([]);
  const busy = useMemo(() => new Set(busyKeys), [busyKeys]);

  const refresh = () => {
    setLoading(true);
    setError(undefined);
    void window.ideaBridgeApi.getSnapshot()
      .then(setSnapshot)
      .catch((nextError) => setError(errorMessage(nextError)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let mounted = true;
    window.ideaBridgeApi.getSnapshot()
      .then((value) => { if (mounted) setSnapshot(value); })
      .catch((nextError) => { if (mounted) setError(errorMessage(nextError)); })
      .finally(() => { if (mounted) setLoading(false); });
    const remove = window.ideaBridgeApi.onChanged((value) => {
      if (mounted) {
        setSnapshot(value);
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
      remove();
    };
  }, []);

  const runOperation = (key: string, operation: () => Promise<unknown>) => {
    if (busy.has(key)) return;
    setError(undefined);
    setBusyKeys((current) => [...current, key]);
    void operation()
      .catch((nextError) => setError(errorMessage(nextError)))
      .finally(() => setBusyKeys((current) => current.filter((item) => item !== key)));
  };

  return (
    <aside className="idea-run-panel">
      <header className="idea-panel-header">
        <div>
          <h2>IDEA</h2>
          <span>{t("idea.subtitle")}</span>
        </div>
        <button type="button" title={t("idea.refresh")} aria-label={t("idea.refresh")} disabled={loading} onClick={refresh}>
          <RefreshCw aria-hidden="true" className={loading ? "spin" : undefined} />
        </button>
      </header>
      {error && <div className="idea-panel-error"><CircleAlert aria-hidden="true" /><span>{error}</span></div>}
      {!loading && snapshot.connections.length === 0 && (
        <div className="idea-panel-empty">
          <PlugZap aria-hidden="true" />
          <strong>{t("idea.notConnected")}</strong>
          <p>{t("idea.installHint")}</p>
          <code>idea-plugin/build/distributions</code>
        </div>
      )}
      <div className="idea-connections">
        {snapshot.connections.map((connection) => (
          <section className="idea-connection" key={connection.bridgeId}>
            <div className="idea-connection-header">
              <span className={`idea-connection-dot ${connection.status}`} />
              <div>
                <strong>{connection.productName}</strong>
                <span>{connection.productVersion} · PID {connection.pid}</span>
              </div>
            </div>
            {connection.error && <div className="idea-connection-error">{connection.error}</div>}
            {connection.status === "connected" && connection.projects.length === 0 && <div className="idea-project-empty">{t("idea.noProjects")}</div>}
            {connection.projects.map((project) => (
              <section className="idea-project" key={project.id}>
                <div className="idea-project-header">
                  <strong>{project.name}</strong>
                  <span title={project.path}>{project.path}</span>
                </div>
                {project.configurations.length === 0
                  ? <div className="idea-project-empty">{t("idea.noConfigurations")}</div>
                  : project.configurations.map((configuration) => (
                    <ConfigurationCard
                      key={configuration.id}
                      bridgeId={connection.bridgeId}
                      projectId={project.id}
                      configuration={configuration}
                      busy={busy}
                      runOperation={runOperation}
                    />
                  ))}
              </section>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}
