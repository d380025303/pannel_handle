import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, BookOpen, Languages, Lock, RefreshCw, Save, Search } from "lucide-react";
import { useI18n } from "../../i18n";
import type { SkillDocument, SkillProvider, SkillSummary, SkillTranslationError } from "../../vite-env";
import { RemoteCodeEditor } from "../remote/RemoteCodeEditor";

type SkillsManagerProps = {
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onRegisterSave: (handler: (() => Promise<boolean>) | null) => void;
};

export function SkillsManager({ onClose, onDirtyChange, onRegisterSave }: SkillsManagerProps) {
  const { t } = useI18n();
  const [provider, setProvider] = useState<SkillProvider>("codex");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [document, setDocument] = useState<SkillDocument | null>(null);
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDocument, setLoadingDocument] = useState(false);
  const [saving, setSaving] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translation, setTranslation] = useState<{ source: string; content: string } | null>(null);
  const [showingTranslation, setShowingTranslation] = useState(false);
  const [error, setError] = useState("");
  const [translationError, setTranslationError] = useState("");
  const [notice, setNotice] = useState("");
  const requestRef = useRef(0);
  const translationRequestRef = useRef<string | null>(null);
  const dirty = Boolean(document?.editable && content !== document.content);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const cancelTranslation = useCallback(() => {
    const requestId = translationRequestRef.current;
    if (!requestId) return;
    translationRequestRef.current = null;
    setTranslating(false);
    void window.skillsApi.cancelTranslation(requestId);
  }, []);

  const resetTranslation = useCallback(() => {
    cancelTranslation();
    setTranslation(null);
    setShowingTranslation(false);
    setTranslationError("");
  }, [cancelTranslation]);

  const openSkill = useCallback(async (skill: SkillSummary) => {
    resetTranslation();
    const requestId = ++requestRef.current;
    setSelectedId(skill.id);
    setLoadingDocument(true);
    setError("");
    setNotice("");
    try {
      const next = await window.skillsApi.read(skill.id);
      if (requestRef.current !== requestId) return;
      setDocument(next);
      setContent(next.content);
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setDocument(null);
      setContent("");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestRef.current === requestId) setLoadingDocument(false);
    }
  }, [resetTranslation]);

  const loadSkills = useCallback(async (nextProvider: SkillProvider) => {
    const requestId = ++requestRef.current;
    setLoadingList(true);
    setLoadingDocument(false);
    setSkills([]);
    setSelectedId(null);
    setDocument(null);
    setContent("");
    setError("");
    setNotice("");
    try {
      const nextSkills = await window.skillsApi.list(nextProvider);
      if (requestRef.current !== requestId) return;
      setSkills(nextSkills);
      setLoadingList(false);
      if (nextSkills[0]) await openSkill(nextSkills[0]);
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setError(err instanceof Error ? err.message : String(err));
      setLoadingList(false);
    }
  }, [openSkill]);

  useEffect(() => { void loadSkills("codex"); }, [loadSkills]);
  useEffect(() => () => cancelTranslation(), [cancelTranslation]);
  useEffect(() => {
    let active = true;
    const unsubscribe = window.agentTokenStatsApi.onChanged(() => {
      void window.skillsApi.list(provider).then(nextSkills => {
        if (active) setSkills(nextSkills);
      }).catch(() => undefined);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [provider]);

  const confirmDiscard = useCallback(() => !dirty || window.confirm(t("skills.discardChanges")), [dirty, t]);

  const save = useCallback(async () => {
    if (!document || !document.editable || !dirty) return true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await window.skillsApi.save(document.id, content, document.version);
      if (result.status === "conflict") {
        setError(t("skills.conflict"));
        return false;
      }
      setDocument((current) => current && current.id === document.id
        ? { ...current, content, version: result.version }
        : current);
      setNotice(t("skills.saved"));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [content, dirty, document, t]);

  useEffect(() => {
    onRegisterSave(save);
    return () => onRegisterSave(null);
  }, [onRegisterSave, save]);

  const switchProvider = (nextProvider: SkillProvider) => {
    if (nextProvider === provider || !confirmDiscard()) return;
    setProvider(nextProvider);
    setQuery("");
    void loadSkills(nextProvider);
  };

  const selectSkill = (skill: SkillSummary) => {
    if (skill.id === selectedId || !confirmDiscard()) return;
    void openSkill(skill);
  };

  const handleClose = () => {
    if (confirmDiscard()) {
      cancelTranslation();
      onClose();
    }
  };

  const translationErrorText = useCallback((reason: SkillTranslationError) => {
    const keys: Record<SkillTranslationError, Parameters<typeof t>[0]> = {
      invalid_request: "skills.translationFailed",
      unavailable: "skills.translationUnavailable",
      too_large: "skills.translationTooLarge",
      cli_missing: "skills.translationCliMissing",
      not_authenticated: "skills.translationNotAuthenticated",
      timeout: "skills.translationTimeout",
      cancelled: "skills.translationCancelled",
      invalid_output: "skills.translationInvalidOutput",
      failed: "skills.translationFailed"
    };
    return t(keys[reason]);
  }, [t]);

  const toggleTranslation = useCallback(async () => {
    if (!document || translating) return;
    if (showingTranslation) {
      setShowingTranslation(false);
      return;
    }
    if (translation?.source === content) {
      setShowingTranslation(true);
      return;
    }
    const requestId = `skill-translation-${Date.now()}-${requestRef.current}`;
    translationRequestRef.current = requestId;
    setTranslating(true);
    setTranslationError("");
    setNotice("");
    try {
      const result = await window.skillsApi.translate(requestId, document.id, content);
      if (translationRequestRef.current !== requestId) return;
      if (result.status === "error") {
        if (result.reason !== "cancelled") setTranslationError(translationErrorText(result.reason));
        return;
      }
      setTranslation({ source: content, content: result.translatedContent });
      setShowingTranslation(true);
    } catch (err) {
      if (translationRequestRef.current === requestId) setTranslationError(err instanceof Error ? err.message : String(err));
    } finally {
      if (translationRequestRef.current === requestId) {
        translationRequestRef.current = null;
        setTranslating(false);
      }
    }
  }, [content, document, showingTranslation, translation, translating, translationErrorText]);

  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return skills;
    return skills.filter((skill) => `${skill.name}\n${skill.description}\n${skill.directoryName}`.toLocaleLowerCase().includes(normalized));
  }, [query, skills]);

  return (
    <main className="skills-page">
      <header className="skills-header">
        <div>
          <button className="icon-button" type="button" onClick={handleClose} title={t("skills.back")} aria-label={t("skills.back")}><ArrowLeft aria-hidden="true" /></button>
          <BookOpen aria-hidden="true" />
          <div><h1>{t("skills.title")}</h1><p>{t("skills.description")}</p></div>
        </div>
        <button className="skills-save" type="button" disabled={!dirty || saving || !document?.editable || showingTranslation} onClick={() => void save()}>
          <Save aria-hidden="true" />{saving ? t("skills.saving") : t("common.save")}
        </button>
      </header>

      <div className="skills-provider-tabs" role="tablist" aria-label={t("skills.provider")}>
        <button type="button" role="tab" aria-selected={provider === "codex"} className={provider === "codex" ? "active" : ""} onClick={() => switchProvider("codex")}>Codex</button>
        <button type="button" role="tab" aria-selected={provider === "codebuddy"} className={provider === "codebuddy" ? "active" : ""} onClick={() => switchProvider("codebuddy")}>CodeBuddy</button>
      </div>

      <div className="skills-workspace">
        <aside className="skills-sidebar">
          <div className="skills-list-toolbar">
            <label><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("skills.search")} aria-label={t("skills.search")} /></label>
            <button className="icon-button" type="button" disabled={loadingList} title={t("common.refresh")} aria-label={t("common.refresh")} onClick={() => { if (confirmDiscard()) void loadSkills(provider); }}><RefreshCw className={loadingList ? "spin" : ""} aria-hidden="true" /></button>
          </div>
          <div className="skills-list">
            {loadingList ? <p className="skills-list-state">{t("common.loading")}</p> : filteredSkills.length === 0 ? (
              <div className="skills-empty"><BookOpen aria-hidden="true" /><strong>{query ? t("skills.noMatches") : t("skills.empty")}</strong>{!query && provider === "codebuddy" && <span>{t("skills.codebuddyEmptyHint")}</span>}</div>
            ) : filteredSkills.map((skill) => (
              <button className={`skills-list-item${selectedId === skill.id ? " active" : ""}`} type="button" key={skill.id} onClick={() => selectSkill(skill)} title={skill.path}>
                <span><strong>{skill.name}</strong>{!skill.editable && <Lock aria-label={t("skills.readOnly")} />}</span>
                {skill.description && <small>{skill.description}</small>}
                <div className="skills-list-meta"><em>{skill.source === "system" ? t("skills.systemSource") : t("skills.userSource")}</em><span>{t("skills.usageCount", { count: skill.usageCount })}</span></div>
              </button>
            ))}
          </div>
        </aside>

        <section className="skills-editor-panel">
          {loadingDocument ? <div className="skills-editor-state">{t("common.loading")}</div> : document ? (
            <>
              <div className="skills-document-header">
                <div><h2>{document.name}{dirty && <span title={t("skills.unsaved")}> *</span>}</h2><p title={document.path}>{document.path}</p></div>
                <div className="skills-document-actions">
                  {!document.editable && <span className="skills-readonly"><Lock aria-hidden="true" />{t("skills.readOnly")}</span>}
                  <button className="skills-translate" type="button" disabled={translating} onClick={() => void toggleTranslation()}>
                    <Languages className={translating ? "spin" : ""} aria-hidden="true" />
                    {translating ? t("skills.translating") : showingTranslation ? t("skills.viewOriginal") : t("skills.translate")}
                  </button>
                </div>
              </div>
              {document.warning && <div className="skills-warning" role="status">{document.warning}</div>}
              {error && <div className="skills-error" role="alert">{error}<button type="button" onClick={() => { if (confirmDiscard()) void openSkill(skills.find((skill) => skill.id === document.id) || document); }}>{t("skills.reload")}</button></div>}
              {notice && <div className="skills-notice" role="status">{notice}</div>}
              {translationError && <div className="skills-error" role="alert">{translationError}<button type="button" onClick={() => void toggleTranslation()}>{t("common.retry")}</button></div>}
              {showingTranslation && <div className="skills-translation-notice" role="status">{t("skills.translationPreview")}</div>}
              <div className="skills-editor">
                <RemoteCodeEditor
                  documentId={document.id}
                  value={showingTranslation ? translation?.content || "" : content}
                  fileName="SKILL.md"
                  languageMode="auto"
                  viewport={{ scrollTop: 0, scrollLeft: 0 }}
                  readOnly={!document.editable || showingTranslation}
                  showLanguageSelector={false}
                  onChange={(value) => { setContent(value); setTranslation(null); setTranslationError(""); setNotice(""); }}
                  onLanguageModeChange={() => undefined}
                  onSave={() => void save()}
                  onViewportChange={() => undefined}
                />
              </div>
            </>
          ) : <div className="skills-editor-state">{error || t("skills.selectHint")}</div>}
        </section>
      </div>
    </main>
  );
}
