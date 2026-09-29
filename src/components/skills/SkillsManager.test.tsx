// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { SkillSummary, SkillsCatalog, TerminalSession } from "../../vite-env";
import { SkillsManager } from "./SkillsManager";

const codexSkills: SkillSummary[] = [
  { id: "review", name: "review", description: "Review code changes", path: "C:\\repo\\.agents\\skills\\review\\SKILL.md", source: "project", enabled: true },
  { id: "imagegen", name: "imagegen", description: "Generate and edit images", path: "C:\\home\\.codex\\skills\\.system\\imagegen\\SKILL.md", source: "system", enabled: true },
  { id: "summaryless", name: "summaryless", description: "", path: "C:\\home\\.agents\\skills\\summaryless\\SKILL.md", source: "personal", enabled: false },
  { id: "figma", name: "figma", description: "Use Figma", path: "C:\\home\\.codex\\plugins\\cache\\figma\\SKILL.md", source: "plugin", enabled: true }
];

const codeBuddySkills: SkillSummary[] = [
  { id: "browser", name: "browser", description: "Control a browser session", path: "C:\\home\\.codebuddy\\skills\\browser\\SKILL.md", source: "personal", enabled: true }
];

const list = vi.fn();
const codexCatalog: SkillsCatalog = { skills: codexSkills, pluginStatus: "available", projectStatus: "available", projectPath: "C:\\repo" };
const codeBuddyCatalog: SkillsCatalog = { skills: codeBuddySkills, pluginStatus: "not-applicable", projectStatus: "not-applicable" };

function renderManager(session?: TerminalSession) {
  return render(
    <I18nProvider locale="en-US">
      <SkillsManager session={session} />
    </I18nProvider>
  );
}

describe("SkillsManager", () => {
  beforeEach(() => {
    list.mockReset();
    list.mockImplementation(async (provider) => provider === "codex" ? codexCatalog : codeBuddyCatalog);
    Object.defineProperty(window, "skillsApi", { configurable: true, value: { list } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("groups Codex skills by source and shows disabled state", async () => {
    renderManager();

    expect(await screen.findByRole("heading", { name: "review" })).toBeTruthy();
    expect(screen.getByText("Review code changes")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "summaryless" })).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(screen.getByRole("region", { name: "Project" }).querySelectorAll("article")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Personal" }).querySelectorAll("article")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Built-in" }).querySelectorAll("article")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Plugin" }).querySelectorAll("article")).toHaveLength(1);
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /save|delete|translate/i })).toBeNull();
  });

  it("filters cards by name and description", async () => {
    renderManager();
    await screen.findByRole("heading", { name: "review" });

    fireEvent.change(screen.getByRole("textbox", { name: "Search Skills" }), { target: { value: "images" } });

    expect(screen.getByRole("heading", { name: "imagegen" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "review" })).toBeNull();
  });

  it("switches providers and clears the active search", async () => {
    renderManager();
    await screen.findByRole("heading", { name: "review" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search Skills" }), { target: { value: "review" } });

    fireEvent.click(screen.getByRole("tab", { name: "CodeBuddy" }));

    expect(await screen.findByRole("heading", { name: "browser" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Search Skills" }) as HTMLInputElement).value).toBe("");
    expect(list).toHaveBeenLastCalledWith("codebuddy", undefined);
  });

  it("refreshes the current provider", async () => {
    renderManager();
    await screen.findByRole("heading", { name: "review" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenLastCalledWith("codex", undefined);
  });

  it("shows provider-specific empty state", async () => {
    list.mockImplementation(async (provider) => provider === "codex" ? codexCatalog : { ...codeBuddyCatalog, skills: [] });
    renderManager();
    await screen.findByRole("heading", { name: "review" });

    fireEvent.click(screen.getByRole("tab", { name: "CodeBuddy" }));

    expect(await screen.findByText("No Skills found")).toBeTruthy();
    expect(screen.getByText(/\.codebuddy\/skills/)).toBeTruthy();
  });

  it("shows list failures without retaining stale cards", async () => {
    list.mockRejectedValueOnce(new Error("Unable to read Skills"));
    renderManager();

    expect((await screen.findByRole("alert")).textContent).toContain("Unable to read Skills");
    expect(screen.queryByRole("article")).toBeNull();
  });

  it("requests the active session and explains unavailable plugin skills without a graphical session", async () => {
    list.mockResolvedValueOnce({ skills: codexSkills.slice(0, 1), pluginStatus: "requires-session",
      projectStatus: "available", projectPath: "C:\\repo" } satisfies SkillsCatalog);
    const session = { id: "run-1", type: "windows", cwd: "C:\\repo" } as TerminalSession;
    renderManager(session);

    expect(await screen.findByRole("heading", { name: "review" })).toBeTruthy();
    expect(list).toHaveBeenCalledWith("codex", "run-1");
    expect(screen.getByText(/Open a Codex graphical session/)).toBeTruthy();
  });
});
