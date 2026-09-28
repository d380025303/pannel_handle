import { useState } from "react";
import type { AgentProvider, GraphicalQuestion } from "./types";
import { GraphicalIcon } from "./GraphicalIcon";

export function GraphicalQuestionCard({ question, provider, onAnswer, onCancel }: {
  question: GraphicalQuestion;
  provider: AgentProvider;
  onAnswer: (id: number | string, answers: Record<string, { answers: string[] }>) => void;
  onCancel: (id: number | string) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const submit = () => {
    const answers: Record<string, { answers: string[] }> = {};
    for (const entry of question.params.questions) {
      const choice = choices[entry.id] || [];
      const note = (notes[entry.id] || "").trim();
      if ((!choice.length && !note) || (entry.options?.length && !choice.length && !entry.isOther)) {
        setError(`请回答「${entry.header || entry.question}」。`);
        return;
      }
      answers[entry.id] = { answers: provider === "codebuddy" || provider === "claude" || provider === "opencode"
        ? [...(entry.multiSelect ? choice : note ? [] : choice), ...(note ? [note] : [])]
        : [...choice, ...(note ? [`user_note: ${note}`] : [])] };
    }
    setError("");
    onAnswer(question.requestId, answers);
  };
  return <article className="graphical-card" aria-label="待回答问题">
    <strong>需要回答</strong>
    {question.params.questions.map(entry => <div className="graphical-question" key={entry.id}>
      <span>{entry.question}</span>
      {entry.options?.length && entry.multiSelect ? entry.options.map(option => <label className="graphical-question-choice" key={option.label}>
        <input type="checkbox" checked={choiceIncludes(choices[entry.id], option.label)}
          onChange={() => setChoices(current => ({ ...current, [entry.id]: choiceIncludes(current[entry.id], option.label)
            ? current[entry.id].filter(value => value !== option.label) : [...(current[entry.id] || []), option.label] }))} />
        {option.label}{option.description ? ` · ${option.description}` : ""}
      </label>) : entry.options?.length ? <select aria-label={entry.question} value={choices[entry.id]?.[0] || ""} onChange={event => {
        setChoices(current => ({ ...current, [entry.id]: event.target.value ? [event.target.value] : [] }));
        if (provider !== "codex") setNotes(current => ({ ...current, [entry.id]: "" }));
      }}>
        <option value="">请选择</option>
        {entry.options.map(option => <option key={option.label} value={option.label}>{option.label}{option.description ? ` · ${option.description}` : ""}</option>)}
      </select> : null}
      {(provider !== "claude" && provider !== "opencode" || entry.isOther) && <input type={entry.isSecret ? "password" : "text"} aria-label={`${entry.question}的自定义回答`} value={notes[entry.id] || ""} placeholder={entry.options?.length ? "补充说明或自定义回答" : "回答"}
        onChange={event => { setNotes(current => ({ ...current, [entry.id]: event.target.value }));
          if (provider !== "codex" && !entry.multiSelect) setChoices(current => ({ ...current, [entry.id]: [] })); }} />}
    </div>)}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="primary" disabled={question.submitting} onClick={submit}><GraphicalIcon name="check" />提交回答</button>
    {(provider === "codebuddy" || provider === "claude" || provider === "opencode") && <button type="button" disabled={question.submitting} onClick={() => onCancel(question.requestId)}><GraphicalIcon name="close" />取消提问</button>}
  </article>;
}

function choiceIncludes(choices: string[] | undefined, label: string) { return choices?.includes(label) || false; }

