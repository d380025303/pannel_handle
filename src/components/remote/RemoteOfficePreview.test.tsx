// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteOfficePreview } from "./RemoteOfficePreview";

const mocks = vi.hoisted(() => ({
  renderDocx: vi.fn(async (_buffer: ArrayBuffer, host: HTMLElement, _styles: HTMLElement, options: unknown) => {
    const anchor = document.createElement("a");
    anchor.href = "https://example.com/report";
    anchor.textContent = "Report link";
    host.append(anchor);
    return options;
  }),
  disposePptx: vi.fn(),
  openPptx: vi.fn()
}));

vi.mock("docx-preview", () => ({ renderAsync: mocks.renderDocx }));
vi.mock("@aiden0z/pptx-renderer", () => ({
  RECOMMENDED_ZIP_LIMITS: { maxEntries: 4000 },
  PptxViewer: { open: mocks.openPptx }
}));

vi.mock("exceljs", () => {
  class Workbook {
    worksheets = [
      {
        name: "Summary",
        actualRowCount: 2,
        actualColumnCount: 2,
        model: { merges: ["A1:B1"] },
        getColumn: () => ({ width: 12 }),
        getCell: (row: number, column: number) => ({
          text: row === 1 && column === 1 ? "Merged title" : row === 2 && column === 1 ? "42" : "",
          font: row === 1 ? { bold: true } : {},
          alignment: {},
          border: {},
          fill: {}
        })
      },
      {
        name: "Details",
        actualRowCount: 1,
        actualColumnCount: 1,
        model: { merges: [] },
        getColumn: () => ({ width: 10 }),
        getCell: () => ({ text: "Detail value", font: {}, alignment: {}, border: {}, fill: {} })
      }
    ];
    xlsx = { load: vi.fn(async () => this) };
  }
  return { default: { Workbook } };
});

describe("RemoteOfficePreview", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocks.renderDocx.mockClear();
    mocks.openPptx.mockReset();
    mocks.disposePptx.mockClear();
  });

  function mockFetch() {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
  }

  it("renders DOCX safely and routes HTTP links through the controlled external API", async () => {
    mockFetch();
    const open = vi.fn(async () => undefined);
    window.externalLinkApi = { open } as unknown as typeof window.externalLinkApi;

    render(<RemoteOfficePreview format="word" url="pannel-media://preview/docx" fileName="report.docx" />);

    const link = await screen.findByRole("link", { name: "Report link" });
    expect(mocks.renderDocx).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.any(HTMLElement), expect.any(HTMLElement), expect.objectContaining({
      renderAltChunks: false,
      ignoreLastRenderedPageBreak: false
    }));
    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith("https://example.com/report");
  });

  it("renders workbook sheets and switches the active worksheet", async () => {
    mockFetch();

    render(<RemoteOfficePreview format="spreadsheet" url="pannel-media://preview/xlsx" fileName="report.xlsx" />);

    expect(await screen.findByText("Merged title")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(await screen.findByText("Detail value")).toBeTruthy();
  });

  it("uses bounded lazy PPTX rendering and disposes the viewer on unmount", async () => {
    mockFetch();
    mocks.openPptx.mockResolvedValue({ dispose: mocks.disposePptx });

    const view = render(<RemoteOfficePreview format="presentation" url="pannel-media://preview/pptx" fileName="slides.pptx" />);

    await waitFor(() => expect(mocks.openPptx).toHaveBeenCalledWith(expect.any(ArrayBuffer), expect.any(HTMLElement), expect.objectContaining({
      lazySlides: true,
      lazyMedia: true,
      pdfjs: false,
      listOptions: expect.objectContaining({ windowed: true })
    })));
    view.unmount();
    expect(mocks.disposePptx).toHaveBeenCalledTimes(1);
  });
});
