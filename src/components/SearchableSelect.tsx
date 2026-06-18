import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { useI18n } from "../i18n";

export type SearchableSelectOption = {
  value: string;
  label: string;
  searchText?: string;
  disabled?: boolean;
};

type SearchableSelectProps = {
  value: string;
  options: SearchableSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  menuMinWidth?: number;
};

export function filterSearchableSelectOptions(options: SearchableSelectOption[], query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;

  return options.filter((option) => (
    `${option.label}\n${option.value}\n${option.searchText ?? ""}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ));
}

export function SearchableSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  disabled = false,
  className = "",
  menuMinWidth = 180
}: SearchableSelectProps) {
  const { t } = useI18n();
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});

  const selectedOption = options.find((option) => option.value === value);
  const filteredOptions = useMemo(
    () => filterSearchableSelectOptions(options, query),
    [options, query]
  );

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = 4;
    const width = Math.min(
      Math.max(rect.width, menuMinWidth),
      window.innerWidth - viewportPadding * 2
    );
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      window.innerWidth - width - viewportPadding
    );
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const openAbove = spaceBelow < 220 && spaceAbove > spaceBelow;

    setMenuStyle({
      left,
      width,
      ...(openAbove
        ? { bottom: window.innerHeight - rect.top + gap, maxHeight: Math.max(120, spaceAbove - gap) }
        : { top: rect.bottom + gap, maxHeight: Math.max(120, spaceBelow - gap) })
    });
  }, [menuMinWidth]);

  const openSelect = useCallback((initialQuery = "") => {
    if (disabled) return;
    setQuery(initialQuery);
    setOpen(true);
  }, [disabled]);

  const selectOption = useCallback((option: SearchableSelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    close(true);
  }, [close, onChange]);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    searchRef.current?.focus();
    searchRef.current?.select();

    const handleViewportChange = () => updatePosition();
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [close, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = query
      ? -1
      : filteredOptions.findIndex((option) => option.value === value && !option.disabled);
    const firstEnabledIndex = filteredOptions.findIndex((option) => !option.disabled);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : firstEnabledIndex);
  }, [filteredOptions, open, query, value]);

  const moveActive = (delta: number) => {
    if (filteredOptions.length === 0) return;
    let next = activeIndex;
    for (let attempts = 0; attempts < filteredOptions.length; attempts += 1) {
      next = (next + delta + filteredOptions.length) % filteredOptions.length;
      if (!filteredOptions[next].disabled) {
        setActiveIndex(next);
        document.getElementById(`${listboxId}-option-${next}`)?.scrollIntoView({ block: "nearest" });
        return;
      }
    }
  };

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = filteredOptions[activeIndex];
      if (option) selectOption(option);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close();
    }
  };

  const triggerClassName = ["searchable-select", open ? "open" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <button
        ref={triggerRef}
        className={triggerClassName}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={disabled}
        title={selectedOption?.label ?? placeholder ?? ariaLabel}
        onClick={() => open ? close() : openSelect()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openSelect();
          } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
            event.preventDefault();
            openSelect(event.key);
          }
        }}
      >
        <span className={`searchable-select-value${selectedOption ? "" : " placeholder"}`}>
          {selectedOption?.label ?? placeholder ?? t("common.select")}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="searchable-select-menu"
          style={menuStyle}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="searchable-select-search">
            <Search aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              role="combobox"
              aria-label={t("common.searchOptions")}
              aria-controls={listboxId}
              aria-expanded="true"
              aria-autocomplete="list"
              aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
              placeholder={t("common.searchOptions")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </div>
          <div className="searchable-select-options" id={listboxId} role="listbox">
            {filteredOptions.length === 0 ? (
              <div className="searchable-select-empty">{t("common.noMatchingOptions")}</div>
            ) : filteredOptions.map((option, index) => (
              <button
                id={`${listboxId}-option-${index}`}
                className={`${index === activeIndex ? "active" : ""}${option.value === value ? " selected" : ""}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                disabled={option.disabled}
                title={option.label}
                key={option.value}
                onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectOption(option)}
              >
                <span>{option.label}</span>
                {option.value === value && <Check aria-hidden="true" />}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
