import type { ReactNode } from "react";
import { useId } from "react";
import { ChevronDown, X } from "lucide-react";
import { useI18n } from "../../i18n";

type SessionModalLayoutProps = {
  title: string;
  subtitle: string;
  onCancel: () => void;
  children: ReactNode;
  footer: ReactNode;
};

export function SessionModalLayout({ title, subtitle, onCancel, children, footer }: SessionModalLayoutProps) {
  const { t } = useI18n();
  const titleId = useId();

  return (
    <div className="modal-overlay">
      <div className="modal-dialog session-form-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="session-form-header">
          <div>
            <h3 id={titleId}>{title}</h3>
            <p>{subtitle}</p>
          </div>
          <button type="button" className="session-form-close" aria-label={t("common.close")} onClick={onCancel}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="modal-body session-form-body">{children}</div>
        <footer className="modal-footer session-form-footer">{footer}</footer>
      </div>
    </div>
  );
}

type SessionFormSectionProps = {
  title: string;
  summary?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
};

export function SessionFormSection({ title, summary, collapsible = false, defaultOpen = false, className = "", children }: SessionFormSectionProps) {
  const sectionClass = `session-form-section${className ? ` ${className}` : ""}`;
  if (collapsible) {
    return (
      <details className={`${sectionClass} collapsible`} open={defaultOpen || undefined}>
        <summary className="session-form-section-heading">
          <span>{title}</span>
          {summary && <span className="session-form-section-summary">{summary}</span>}
          <ChevronDown className="session-form-section-chevron" aria-hidden="true" />
        </summary>
        <div className="session-form-section-content">{children}</div>
      </details>
    );
  }

  return (
    <section className={sectionClass}>
      <div className="session-form-section-heading">
        <span>{title}</span>
        {summary && <span className="session-form-section-summary">{summary}</span>}
      </div>
      <div className="session-form-section-content">{children}</div>
    </section>
  );
}
