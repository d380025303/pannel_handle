// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import type { SkillSummary } from "../../vite-env";
import { SkillsManager } from "./SkillsManager";

const codexSkills: SkillSummary[] = [
  { id: "review", name: "review", description: "Review code changes" },
  { id: "imagegen", name: "imagegen", description: "Generate and edit images" },
  { id: "summaryless", name: "summaryless", description: "" }
];

const codeBuddySkills: SkillSummary[] = [
  { id: "browser", name: "browser", description: "Control a browser session" }
];

const list = vi.fn();

function renderManager() {
  return render(
    <I18nProvider locale="en-US">
      <SkillsManager onClose={() => undefined} />
    </I18nProvider>
  );
}

describe("SkillsManager", () => {
  beforeEach(() => {
    list.mockReset();
    list.mockImplementation(async (provider) => provider === "codex" ? codexSkills : codeBuddySkills);
    Object.defineProperty(window, "skillsApi", { configurable: true, value: { list } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders non-interactive cards containing only each Skill name and description", async () => {
    renderManager();

    expect(await screen.findByRole("heading", { name: "review" })).toBeTruthy();
    expect(screen.getByText("Review code changes")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "summaryless" })).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.queryByLabelText("SKILL.md")).toBeNull();
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
    expect(list).toHaveBeenLastCalledWith("codebuddy");
  });

  it("refreshes the current provider", async () => {
    renderManager();
    await screen.findByRole("heading", { name: "review" });

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenLastCalledWith("codex");
  });

  it("shows provider-specific empty state", async () => {
    list.mockImplementation(async (provider) => provider === "codex" ? codexSkills : []);
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
});
