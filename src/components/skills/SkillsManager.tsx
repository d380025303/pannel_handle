import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, RefreshCw, Search } from "lucide-react";
import { useI18n } from "../../i18n";
import type { SkillProvider, SkillSummary } from "../../vite-env";

export function SkillsManager() {
  const { t } = useI18n();
  const [provider, setProvider] = useState<SkillProvider>("codex");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestRef = useRef(0);

  const loadSkills = useCallback(async (nextProvider: SkillProvider) => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError("");
    try {
      const nextSkills = await window.skillsApi.list(nextProvider);
      if (requestRef.current === requestId) setSkills(nextSkills);
    } catch (err) {
      if (requestRef.current === requestId) {
        setSkills([]);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadSkills("codex"); }, [loadSkills]);

  const switchProvider = (nextProvider: SkillProvider) => {
    if (nextProvider === provider) return;
    setProvider(nextProvider);
    setQuery("");
    void loadSkills(nextProvider);
  };

  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return skills;
    return skills.filter((skill) => `${skill.name}\n${skill.description}`.toLocaleLowerCase().includes(normalized));
  }, [query, skills]);

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

      <section className="skills-content">
        <div className="skills-list-toolbar">
          <label><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("skills.search")} aria-label={t("skills.search")} /></label>
          <button className="icon-button" type="button" disabled={loading} title={t("common.refresh")} aria-label={t("common.refresh")} onClick={() => void loadSkills(provider)}><RefreshCw className={loading ? "spin" : ""} aria-hidden="true" /></button>
        </div>

        {loading ? <p className="skills-list-state">{t("common.loading")}</p> : error ? (
          <div className="skills-load-error" role="alert">{error}</div>
        ) : filteredSkills.length === 0 ? (
          <div className="skills-empty"><BookOpen aria-hidden="true" /><strong>{query ? t("skills.noMatches") : t("skills.empty")}</strong>{!query && provider === "codebuddy" && <span>{t("skills.codebuddyEmptyHint")}</span>}</div>
        ) : (
          <div className="skills-card-grid">
            {filteredSkills.map((skill) => (
              <article className="skills-card" key={skill.id}>
                <h2>{skill.name}</h2>
                {skill.description && <p>{skill.description}</p>}
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
