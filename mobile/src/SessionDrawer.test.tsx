import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionDrawer } from "./SessionList";

afterEach(cleanup);

it("isolates the background, cycles focus past disabled actions, and restores the opener", async () => {
  const user = userEvent.setup();
  function Page() {
    const [open, setOpen] = useState(false);
    return <main>
      <header><button onClick={() => setOpen(true)}>打开会话列表</button></header>
      <section data-testid="terminal"><textarea aria-label="后台终端" /></section>
      {open && <SessionDrawer
        closeCompleted={{ busy: false, notice: "", count: 0, disabled: true, close: vi.fn() }}
        {...{ copyingIds: new Set(["session"]) }} sessions={[{ id: "session", title: "测试终端", type: "windows", runtimeMode: "terminal" }]}
        templates={[]} activeId="session" tab="running" onTabChange={vi.fn()} send={() => true}
        onOpen={() => setOpen(false)} onAction={vi.fn()} onClose={() => setOpen(false)} />}
    </main>;
  }
  render(<Page />);
  const opener = screen.getByRole("button", { name: "打开会话列表" });
  await user.click(opener);
  const drawer = screen.getByRole("dialog", { name: "会话列表" });
  const close = within(drawer).getByRole("button", { name: "关闭会话列表" });
  const last = within(drawer).getByRole("button", { name: "关闭" });
  expect(document.activeElement).toBe(close);
  expect(opener.parentElement!.inert).toBe(true);
  expect(screen.getByTestId("terminal").inert).toBe(true);
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(last);
  await user.tab();
  expect(document.activeElement).toBe(close);
  for (let i = 0; i < 15; i++) {
    await user.tab();
    expect(drawer.contains(document.activeElement)).toBe(true);
  }
  await user.keyboard("a{Escape}");
  expect((screen.getByLabelText("后台终端") as HTMLTextAreaElement).value).toBe("");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByTestId("terminal").inert).toBeFalsy();
  expect(document.activeElement).toBe(opener);
  await user.click(opener);
  await user.click(screen.getByRole("button", { name: /测试终端/ }));
  expect(document.activeElement).toBe(opener);
});
