// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpreadsheetSheet, RemoteOfficePreview } from "./RemoteOfficePreview";

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
  function worksheet(merges: string[], actualRowCount = 101, actualColumnCount = 101) {
    return {
      name: "Synthetic",
      actualRowCount,
      actualColumnCount,
      model: { merges },
      getColumn: () => ({ width: 12 }),
      getCell: (row: number, column: number) => ({ text: `${row}:${column}` })
    };
  }

  it("clips merged cells at both preview boundaries and preserves master content", () => {
    const sheet = createSpreadsheetSheet(worksheet(["A1:B2", "CU99:CW102"]));
    expect(sheet.rows).toHaveLength(100);
    expect(sheet.rows[0][0]).toMatchObject({ text: "1:1", rowSpan: 2, colSpan: 2, hidden: false });
    expect(sheet.rows[1][1]).toMatchObject({ text: "", hidden: true });
    expect(sheet.rows[98][98]).toMatchObject({ text: "99:99", rowSpan: 2, colSpan: 2, hidden: false });
    expect(sheet.rows[99][99]).toMatchObject({ text: "", hidden: true });
    expect(sheet.rows[2][2]).toMatchObject({ text: "3:3", hidden: false, rowSpan: undefined });
    expect(sheet.truncated).toBe(true);
  });

  it("does not search all merge ranges for each of the 10,000 preview cells", () => {
    const merges = Array.from({ length: 20_000 }, (_, index) => `A${10_002 + index}:B${10_002 + index}`);
    const find = vi.spyOn(Array.prototype, "find");
    let sheet;
    try {
      sheet = createSpreadsheetSheet(worksheet(merges, 30_001, 100));
      expect(find).not.toHaveBeenCalled();
    } finally {
      find.mockRestore();
    }
    expect(sheet.rows.flat()).toHaveLength(10_000);
    expect(sheet.rows[99][99]).toMatchObject({ text: "100:100", hidden: false });
  });

  it("ignores column-only out-of-bounds merges and preserves first-match overlap behavior", () => {
    const sheet = createSpreadsheetSheet(worksheet(["CW1:CX101", "A1:B2", "B2:C3"]));
    expect(sheet.rows[1][1]).toMatchObject({ hidden: true });
    expect(sheet.rows[0][99]).toMatchObject({ text: "1:100", hidden: false });
  });

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
