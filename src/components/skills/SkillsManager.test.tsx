// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { I18nProvider } from "../../i18n";
import type { SkillDocument, SkillSummary } from "../../vite-env";
import { SkillsManager } from "./SkillsManager";

vi.mock("../remote/RemoteCodeEditor", () => ({
  RemoteCodeEditor: ({ value, readOnly, onChange, onSave }: { value: string; readOnly?: boolean; onChange: (value: string) => void; onSave: () => void }) => (
    <textarea aria-label="SKILL.md" value={value} disabled={readOnly} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => {
      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSave();
      }
    }} />
  )
}));

const userSkill: SkillSummary = {
  id: "user-1",
  provider: "codex",
  source: "user",
  name: "review",
  description: "Review code",
  directoryName: "review",
  path: "C:\\Users\\tester\\.codex\\skills\\review",
  editable: true
};

const systemSkill: SkillSummary = {
  ...userSkill,
  id: "system-1",
  source: "system",
  name: "imagegen",
  directoryName: "imagegen",
  path: "C:\\Users\\tester\\.codex\\skills\\.system\\imagegen",
  editable: false
};

function documentFor(skill: SkillSummary): SkillDocument {
  return { ...skill, content: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\nInstructions`, version: `${skill.id}-v1`, bom: false, eol: "lf" };
}

const list = vi.fn();
const read = vi.fn();
const save = vi.fn();

function renderManager(overrides: Partial<ComponentProps<typeof SkillsManager>> = {}) {
  return render(
    <I18nProvider locale="zh-CN">
      <SkillsManager onClose={() => undefined} onDirtyChange={() => undefined} onRegisterSave={() => undefined} {...overrides} />
    </I18nProvider>
  );
}

describe("SkillsManager", () => {
  beforeEach(() => {
    list.mockReset();
    read.mockReset();
    save.mockReset();
    list.mockImplementation(async (provider) => provider === "codex" ? [userSkill, systemSkill] : []);
    read.mockImplementation(async (id) => documentFor(id === systemSkill.id ? systemSkill : userSkill));
    save.mockResolvedValue({ status: "saved", version: "user-1-v2", size: 20 });
    Object.defineProperty(window, "skillsApi", { configurable: true, value: { list, read, save } });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads Codex skills and exposes system skills as read-only", async () => {
    renderManager();
    expect((await screen.findAllByText("review")).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText("imagegen").closest("button")!);

    await waitFor(() => expect((screen.getByLabelText("SKILL.md") as HTMLTextAreaElement).disabled).toBe(true));
    expect(screen.getAllByText("只读").length).toBeGreaterThan(0);
  });

  it("edits and saves a user SKILL.md", async () => {
    const onDirtyChange = vi.fn();
    renderManager({ onDirtyChange });
    const editor = await screen.findByLabelText("SKILL.md");
    fireEvent.change(editor, { target: { value: "Updated instructions" } });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith("user-1", "Updated instructions", "user-1-v1"));
    expect(await screen.findByText("已保存 SKILL.md")).toBeTruthy();
    expect(onDirtyChange).toHaveBeenCalledWith(true);
  });

  it("keeps the draft when saving reports an external conflict", async () => {
    save.mockResolvedValueOnce({ status: "conflict" });
    renderManager();
    const editor = await screen.findByLabelText("SKILL.md");
    fireEvent.change(editor, { target: { value: "Local draft" } });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });

    expect((await screen.findByRole("alert")).textContent).toContain("已被其他程序修改");
    expect((screen.getByLabelText("SKILL.md") as HTMLTextAreaElement).value).toBe("Local draft");
  });

  it("shows the CodeBuddy empty state without creating anything", async () => {
    renderManager();
    await screen.findByLabelText("SKILL.md");
    fireEvent.click(screen.getByRole("tab", { name: "CodeBuddy" }));

    expect(await screen.findByText("尚未发现 Skills")).toBeTruthy();
    expect(screen.getByText(/\.codebuddy\/skills/)).toBeTruthy();
  });

  it("cancels provider switching when the current draft is dirty", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    renderManager();
    fireEvent.change(await screen.findByLabelText("SKILL.md"), { target: { value: "Draft" } });

    fireEvent.click(screen.getByRole("tab", { name: "CodeBuddy" }));

    expect(screen.getByRole("tab", { name: "Codex" }).getAttribute("aria-selected")).toBe("true");
    expect(list).toHaveBeenCalledTimes(1);
  });
});
