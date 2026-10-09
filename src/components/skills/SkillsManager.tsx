import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, RefreshCw, Search, X } from "lucide-react";
import { useI18n } from "../../i18n";
import { MarkdownBlock } from "../shared/MarkdownBlock";
import type { SkillDetail, SkillSummary, SkillProvider, SkillSource, SkillsCatalog, TerminalSession } from "../../vite-env";

const SOURCES: SkillSource[] = ["project", "personal", "system", "plugin"];

export function SkillsManager({ session }: { session?: TerminalSession }) {
  const { t } = useI18n();
  const [provider, setProvider] = useState<SkillProvider>("codex");
  const [catalog, setCatalog] = useState<SkillsCatalog | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const dialogRef = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState<SkillSummary | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  useEffect(() => {
    if (!selected) return;
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [selected?.id]);
  function closeDetail() { ++detailRequestRef.current; setSelected(null); setDetail(null); setDetailError(""); }
  async function openDetail(skill: SkillSummary) {
    const request = ++detailRequestRef.current;
    setSelected(skill); setDetail(null); setDetailError("");
    try {
      const value = await window.skillsApi.read(provider, skill.id, session?.id);
      if (request === detailRequestRef.current) setDetail(value);
    } catch (err) {
      if (request === detailRequestRef.current) setDetailError(err instanceof Error ? err.message : String(err));
    }
  }
  useEffect(() => {
    closeDetail();
    return () => { ++detailRequestRef.current; ++requestRef.current; };
  }, [provider, session?.id]);

  const loadSkills = useCallback(async (nextProvider: SkillProvider, sessionId?: string) => {
    const requestId = ++requestRef.current;
    closeDetail();
    setLoading(true);
    setError("");
    try {
      const nextCatalog = await window.skillsApi.list(nextProvider, sessionId);
      if (requestRef.current === requestId) setCatalog(nextCatalog);
    } catch (err) {
      if (requestRef.current === requestId) {
        setCatalog(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadSkills(provider, session?.id); }, [loadSkills, provider, session?.id]);

  const switchProvider = (nextProvider: SkillProvider) => {
    if (nextProvider === provider) return;
    setProvider(nextProvider);
    setQuery("");
    setCatalog(null);
    setLoading(true);
  };

  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const skills = catalog?.skills || [];
    if (!normalized) return skills;
    return skills.filter((skill) => `${skill.name}\n${skill.description}\n${skill.path}`.toLocaleLowerCase().includes(normalized));
  }, [query, catalog]);

  const cards = (skills: typeof filteredSkills) => (
    <div className="skills-card-grid">
      {skills.map((skill) => (
        <article className="skills-card" key={skill.id}>
          <div className="skills-card-heading">
            <h3>{skill.name}</h3>
            {!skill.enabled && <span className="skills-disabled">{t("skills.disabled")}</span>}
          </div>
          <button type="button" className="modal-button compact skills-detail-trigger" onClick={() => void openDetail(skill)} aria-label={`${t("skills.viewDetail")}：${skill.name}`}><BookOpen aria-hidden="true" />{t("skills.viewDetail")}</button>
          {skill.description && <p>{skill.description}</p>}
          {provider === "codex" && <small className="skills-card-path" title={skill.path}>{skill.path}</small>}
        </article>
      ))}
    </div>
  );

  return (
    <main className="skills-page">
      <header className="skills-header">
        <div>
          <BookOpen aria-hidden="true" />
          <div><h1>{t("skills.title")}</h1><p>{t("skills.description")}</p></div>
        </div>
      </header>

      <div className="skills-provider-tabs" role="tablist" aria-label={t("skills.provider")}>
        <button type="button" role="tab" aria-selected={provider === "codex"} className={provider === "codex" ? "active" : ""} onClick={() => switchProvider("codex")}>Codex</button>
        <button type="button" role="tab" aria-selected={provider === "codebuddy"} className={provider === "codebuddy" ? "active" : ""} onClick={() => switchProvider("codebuddy")}>CodeBuddy</button>
      </div>

      {selected && createPortal(<div className="modal-overlay skills-detail-overlay" onClick={event => { if (event.target === event.currentTarget) closeDetail(); }}>
        <section ref={dialogRef} className="modal-dialog skills-detail" role="dialog" aria-modal="true" aria-label={`${t("skills.detail")}：${selected.name}`} tabIndex={-1} onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); closeDetail(); }
          if (event.key === "Tab") {
            const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'));
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <header><h2>{selected.name}</h2><button className="modal-button compact" type="button" onClick={closeDetail}><X aria-hidden="true" />{t("skills.closeDetail")}</button></header>
        <div className="skills-detail-content">
        <p>{t(`skills.source.${selected.source}`)} · {selected.enabled ? t("skills.enabled") : t("skills.disabled")}</p>
        {selected.description && <p>{selected.description}</p>}
        <small className="skills-detail-path">{selected.path}</small>
        {detailError ? <div role="alert" className="skills-load-error">{detailError}<button className="modal-button compact" type="button" onClick={() => void openDetail(selected)}><RefreshCw aria-hidden="true" />{t("common.refresh")}</button></div>
          : detail ? <MarkdownBlock className="skills-detail-body" content={detail.content} externalLinks /> : <p role="status">{t("common.loading")}</p>}
        </div>
        </section>
      </div>, document.body)}
      <section className="skills-content">
        <div className="skills-list-toolbar">
          <label><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("skills.search")} aria-label={t("skills.search")} /></label>
          <button className="icon-button" type="button" disabled={loading} title={t("common.refresh")} aria-label={t("common.refresh")} onClick={() => void loadSkills(provider, session?.id)}><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" /></button>
        </div>

        {loading ? <p className="skills-list-state">{t("common.loading")}</p> : error ? (
          <div className="skills-load-error" role="alert">{error}</div>
        ) : provider === "codebuddy" && filteredSkills.length === 0 ? (
          <div className="skills-empty"><BookOpen aria-hidden="true" /><strong>{query ? t("skills.noMatches") : t("skills.empty")}</strong>{!query && provider === "codebuddy" && <span>{t("skills.codebuddyEmptyHint")}</span>}</div>
        ) : provider === "codebuddy" ? cards(filteredSkills)
          : query && filteredSkills.length === 0 ? <div className="skills-empty"><BookOpen aria-hidden="true" /><strong>{t("skills.noMatches")}</strong></div>
            : SOURCES.map((source) => {
              const group = filteredSkills.filter(skill => skill.source === source);
              if (query && group.length === 0) return null;
              const title = t(`skills.source.${source}`);
              const hint = source === "plugin" && catalog?.pluginStatus === "requires-session" ? t("skills.pluginRequiresSession")
                : source === "project" && catalog?.projectStatus === "no-session" ? t("skills.projectRequiresSession")
                  : source === "project" && catalog?.projectStatus === "remote-unavailable" ? t("skills.remoteRequiresCodex")
                    : t("skills.groupEmpty");
              return (
                <section className="skills-group" key={source} aria-label={title}>
                  <div className="skills-group-heading">
                    <h2>{title} <span>{group.length}</span></h2>
                    {source === "project" && catalog?.projectPath && <small title={catalog.projectPath}>{catalog.projectPath}</small>}
                  </div>
                  {group.length ? cards(group) : <p className="skills-group-empty">{hint}</p>}
                </section>
              );
            })}
      </section>
    </main>
  );
}
