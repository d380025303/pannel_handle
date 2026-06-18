import { useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { useI18n } from "../i18n";

type TagInputProps = {
  tags: string[];
  suggestions?: string[];
  onChange: (tags: string[]) => void;
  compact?: boolean;
};

function normalizeTag(value: string) {
  return value.trim();
}

export function TagInput({ tags, suggestions = [], onChange, compact = false }: TagInputProps) {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const availableSuggestions = useMemo(() => {
    const selected = new Set(tags.map((tag) => tag.toLowerCase()));
    return suggestions.filter((tag) => !selected.has(tag.toLowerCase()));
  }, [suggestions, tags]);

  const addTag = (value: string) => {
    const tag = normalizeTag(value);
    if (!tag || tags.some((item) => item.toLowerCase() === tag.toLowerCase())) return;
    onChange([...tags, tag]);
    setInput("");
  };

  const removeTag = (tag: string) => {
    onChange(tags.filter((item) => item !== tag));
  };

  return (
    <div className={`tag-input${compact ? " compact" : ""}`}>
      <div className="tag-input-values">
        {tags.map((tag) => (
          <span className="tag-chip selected" key={tag}>
            {tag}
            <button type="button" aria-label={t("tag.remove", { tag })} onClick={() => removeTag(tag)}>
              <X aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          value={input}
          placeholder={tags.length === 0 ? t("tag.placeholderEmpty") : t("tag.placeholderAdd")}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag(input);
            }
            if (event.key === "Backspace" && !input && tags.length > 0) {
              removeTag(tags[tags.length - 1]);
            }
          }}
          onBlur={() => addTag(input)}
        />
      </div>
      {availableSuggestions.length > 0 && (
        <div className="tag-suggestions">
          {availableSuggestions.map((tag) => (
            <button type="button" className="tag-chip" key={tag} onMouseDown={(e) => { e.preventDefault(); addTag(tag); }}>
              <Plus aria-hidden="true" />
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
