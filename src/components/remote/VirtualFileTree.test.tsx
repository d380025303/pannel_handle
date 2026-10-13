// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualFileTree, type VirtualFileTreeHandle } from "./VirtualFileTree";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("virtual file tree", () => {
  it("reuses offsets and the active path set across scrolling 100,000 unchanged rows", () => {
    const paths = Array.from({ length: 100000 }, (_, index) => `file-${index}`);
    const iterate = vi.spyOn(paths, Symbol.iterator);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 31 } as DOMRect);
    render(<VirtualFileTree paths={paths} resetKey="root" handleRef={createRef<VirtualFileTreeHandle>()} busy={false}
      onScroll={() => {}} empty={null} renderRow={(index) => <button role="treeitem">{paths[index]}</button>} />);
    iterate.mockClear();
    const tree = screen.getByRole("tree");
    for (let index = 1; index <= 20; index++) fireEvent.scroll(tree, { target: { scrollTop: index * 3100 } });
    expect(iterate).not.toHaveBeenCalled();
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(40);
  });

  it("recomputes offsets after row heights and paths change", () => {
    let rowHeight = 90;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { height: this.dataset.virtualIndex === "0" ? rowHeight : 31 } as DOMRect;
    });
    const props = { handleRef: createRef<VirtualFileTreeHandle>(), resetKey: "root", busy: false, onScroll: () => {}, empty: null,
      renderRow: (index: number) => <button role="treeitem">{index}</button> };
    const view = render(<VirtualFileTree {...props} paths={["a", "b", "c"]} />);
    const secondRow = () => view.container.querySelector('[data-virtual-index="1"]') as HTMLElement;
    expect(secondRow().style.top).toBe("90px");
    rowHeight = 120;
    fireEvent.scroll(screen.getByRole("tree"));
    expect(secondRow().style.top).toBe("120px");
    view.rerender(<VirtualFileTree {...props} paths={["b", "c"]} />);
    expect(secondRow().style.top).toBe("120px");
    rowHeight = 0;
    view.rerender(<VirtualFileTree {...props} paths={["a", "b", "c"]} />);
    expect(secondRow().style.top).toBe("31px");
  });

  it("invalidates cached heights when only the root changes", () => {
    let height = 90;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { height: this.dataset.virtualIndex === "0" ? height : 31 } as DOMRect;
    });
    const props = { paths: ["a", "b"], handleRef: createRef<VirtualFileTreeHandle>(), busy: false, onScroll: () => {}, empty: null,
      renderRow: (index: number) => <button role="treeitem">{index}</button> };
    const view = render(<VirtualFileTree {...props} resetKey="first" />);
    expect((view.container.querySelector('[data-virtual-index="1"]') as HTMLElement).style.top).toBe("90px");
    height = 0;
    view.rerender(<VirtualFileTree {...props} resetKey="second" />);
    expect((view.container.querySelector('[data-virtual-index="1"]') as HTMLElement).style.top).toBe("31px");
  });

  it("bounds mounted rows for 10,000 files and reaches the last file", () => {
    const paths = Array.from({ length: 10000 }, (_, index) => `file-${index}`);
    const handleRef = createRef<VirtualFileTreeHandle>();
    const { container } = render(<VirtualFileTree paths={paths} resetKey="root" handleRef={handleRef} busy={false} onScroll={() => {}} empty={null}
      renderRow={(index) => <button role="treeitem">{paths[index]}</button>} />);
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(40);
    fireEvent.scroll(screen.getByRole("tree"), { target: { scrollTop: 310000 } });
    expect(screen.getByText("file-9999")).toBeTruthy();
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(40);
    act(() => handleRef.current?.focus(0));
    expect(document.activeElement).toBe(screen.getByText("file-0"));
    act(() => handleRef.current?.focus(9999));
    expect(document.activeElement).toBe(screen.getByText("file-9999"));
    expect(container.querySelectorAll("[data-virtual-index]").length).toBeLessThan(40);
  });

  it("measures compound rows and resets scrolling when the root changes", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return { height: this.dataset.virtualIndex === "0" ? 90 : 31 } as DOMRect;
    });
    const handleRef = createRef<VirtualFileTreeHandle>();
    const props = { paths: Array.from({ length: 100 }, (_, index) => `${index}`), handleRef, busy: false, onScroll: () => {}, empty: null,
      renderRow: (index: number) => <button role="treeitem">{index}</button> };
    const view = render(<VirtualFileTree {...props} resetKey="first" />);
    expect((view.container.querySelector('[data-virtual-index="1"]') as HTMLElement).style.top).toBe("90px");
    act(() => handleRef.current?.focus(99));
    view.rerender(<VirtualFileTree {...props} resetKey="second" />);
    expect(screen.getByRole("tree").scrollTop).toBe(0);
    expect(screen.getByText("0")).toBeTruthy();
    vi.restoreAllMocks();
  });
});
