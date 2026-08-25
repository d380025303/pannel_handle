import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "../../i18n";
import type { RemoteOfficeFormat } from "../../vite-env";

type RemoteOfficePreviewProps = {
  format: RemoteOfficeFormat;
  url: string;
  fileName: string;
};

type SpreadsheetCell = {
  key: string;
  row: number;
  column: number;
  text: string;
  rowSpan?: number;
  colSpan?: number;
  hidden?: boolean;
  style?: CSSProperties;
};

type SpreadsheetSheet = {
  name: string;
  rows: SpreadsheetCell[][];
  columnWidths: number[];
  truncated: boolean;
};

function colorFromArgb(argb: unknown) {
  const value = typeof argb === "string" ? argb.replace(/^#/, "") : "";
  return /^[0-9a-f]{8}$/i.test(value) ? `#${value.slice(2)}` : /^[0-9a-f]{6}$/i.test(value) ? `#${value}` : undefined;
}

function borderStyle(border: unknown) {
  if (!border || typeof border !== "object") return undefined;
  const edge = border as { style?: string; color?: { argb?: string } };
  if (!edge.style) return undefined;
  const width = edge.style.includes("thick") ? 3 : edge.style.includes("medium") ? 2 : 1;
  return `${width}px solid ${colorFromArgb(edge.color?.argb) || "var(--color-border)"}`;
}

function cellStyle(cell: any): CSSProperties {
  const fontColor = colorFromArgb(cell.font?.color?.argb);
  const fillColor = cell.fill?.type === "pattern" ? colorFromArgb(cell.fill?.fgColor?.argb) : undefined;
  return {
    color: fontColor,
    backgroundColor: fillColor,
    fontFamily: cell.font?.name,
    fontSize: typeof cell.font?.size === "number" ? `${cell.font.size}px` : undefined,
    fontWeight: cell.font?.bold ? 700 : undefined,
    fontStyle: cell.font?.italic ? "italic" : undefined,
    textDecoration: cell.font?.underline ? "underline" : undefined,
    textAlign: ["left", "center", "right", "justify"].includes(cell.alignment?.horizontal)
      ? cell.alignment.horizontal
      : undefined,
    verticalAlign: ["top", "middle", "bottom"].includes(cell.alignment?.vertical)
      ? cell.alignment.vertical
      : undefined,
    whiteSpace: cell.alignment?.wrapText ? "pre-wrap" : "pre",
    borderTop: borderStyle(cell.border?.top),
    borderRight: borderStyle(cell.border?.right),
    borderBottom: borderStyle(cell.border?.bottom),
    borderLeft: borderStyle(cell.border?.left)
  };
}

function parseCellAddress(address: string) {
  const match = /^([A-Z]+)(\d+)$/i.exec(address);
  if (!match) return null;
  let column = 0;
  for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  return { row: Number(match[2]), column };
}

function getMergeRanges(worksheet: any) {
  const ranges = Array.isArray(worksheet.model?.merges) ? worksheet.model.merges : [];
  return ranges.flatMap((range: string) => {
    const [startText, endText] = range.split(":");
    const start = parseCellAddress(startText);
    const end = parseCellAddress(endText || startText);
    return start && end ? [{ start, end }] : [];
  });
}

function createSpreadsheetSheet(worksheet: any): SpreadsheetSheet {
  const actualRows = Math.max(worksheet.actualRowCount || 1, 1);
  const actualColumns = Math.max(worksheet.actualColumnCount || 1, 1);
  const maxColumns = Math.min(actualColumns, 100);
  const maxRows = Math.min(actualRows, Math.max(1, Math.floor(10_000 / maxColumns)));
  const merges = getMergeRanges(worksheet);
  const rows: SpreadsheetCell[][] = [];

  for (let row = 1; row <= maxRows; row += 1) {
    const cells: SpreadsheetCell[] = [];
    for (let column = 1; column <= maxColumns; column += 1) {
      const merge = merges.find((candidate: any) => (
        row >= candidate.start.row && row <= candidate.end.row
        && column >= candidate.start.column && column <= candidate.end.column
      ));
      const isMergeMaster = !merge || (merge.start.row === row && merge.start.column === column);
      const cell = worksheet.getCell(row, column);
      cells.push({
        key: `${row}:${column}`,
        row,
        column,
        text: isMergeMaster ? String(cell.text ?? "") : "",
        hidden: !isMergeMaster,
        rowSpan: merge && isMergeMaster ? Math.min(merge.end.row, maxRows) - row + 1 : undefined,
        colSpan: merge && isMergeMaster ? Math.min(merge.end.column, maxColumns) - column + 1 : undefined,
        style: isMergeMaster ? cellStyle(cell) : undefined
      });
    }
    rows.push(cells);
  }

  return {
    name: worksheet.name,
    rows,
    columnWidths: Array.from({ length: maxColumns }, (_, index) => {
      const width = Number(worksheet.getColumn(index + 1).width) || 10;
      return Math.max(48, Math.min(360, Math.round(width * 8)));
    }),
    truncated: actualRows > maxRows || actualColumns > maxColumns
  };
}

function sanitizeOfficeDom(container: HTMLElement) {
  container.querySelectorAll("iframe, object, embed, script").forEach((element) => element.remove());
  container.querySelectorAll<HTMLElement>("[src]").forEach((element) => {
    const src = element.getAttribute("src") || "";
    if (/^https?:/i.test(src)) element.removeAttribute("src");
  });
}

export function RemoteOfficePreview({ format, url, fileName }: RemoteOfficePreviewProps) {
  const { t } = useI18n();
  const renderHostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [sheets, setSheets] = useState<SpreadsheetSheet[]>([]);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const activeSheet = sheets[activeSheetIndex] || null;

  useEffect(() => {
    const controller = new AbortController();
    const host = renderHostRef.current;
    let disposeViewer: (() => void) | undefined;
    let observer: MutationObserver | undefined;
    setStatus("loading");
    setError("");
    setSheets([]);
    setActiveSheetIndex(0);
    if (host) host.replaceChildren();

    const render = async () => {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(t("files.officeLoadFailed"));
      const buffer = await response.arrayBuffer();
      if (controller.signal.aborted || !host) return;

      if (format === "word") {
        const { renderAsync } = await import("docx-preview");
        await renderAsync(buffer, host, host, {
          className: "office-docx",
          inWrapper: true,
          ignoreLastRenderedPageBreak: false,
          renderAltChunks: false,
          useBase64URL: true
        });
      } else if (format === "spreadsheet") {
        const ExcelJS = (await import("exceljs")).default;
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        if (controller.signal.aborted) return;
        setSheets(workbook.worksheets.map(createSpreadsheetSheet));
      } else {
        const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
        const viewer = await PptxViewer.open(buffer, host, {
          fitMode: "contain",
          lazySlides: true,
          lazyMedia: true,
          pdfjs: false,
          signal: controller.signal,
          zipLimits: RECOMMENDED_ZIP_LIMITS,
          listOptions: { windowed: true, initialSlides: 4, batchSize: 4 }
        });
        disposeViewer = () => {
          const disposable = viewer as unknown as { dispose?: () => void };
          disposable.dispose?.();
        };
      }

      if (controller.signal.aborted) return;
      sanitizeOfficeDom(host);
      observer = new MutationObserver(() => sanitizeOfficeDom(host));
      observer.observe(host, { childList: true, subtree: true });
      setStatus("ready");
    };

    void render().catch((renderError) => {
      if (controller.signal.aborted) return;
      setError(renderError instanceof Error ? renderError.message : String(renderError));
      setStatus("error");
    });

    return () => {
      controller.abort();
      observer?.disconnect();
      disposeViewer?.();
      host?.replaceChildren();
    };
  }, [format, t, url]);

  const handleLinkClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as Element).closest("a");
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    const href = anchor.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) void window.externalLinkApi.open(href);
  };

  const columnGroup = useMemo(() => activeSheet?.columnWidths.map((width, index) => (
    <col key={index} style={{ width }} />
  )), [activeSheet]);

  return (
    <div className={`remote-preview-office remote-preview-office-${format}`} onClickCapture={handleLinkClick}>
      {status === "loading" && <div className="remote-file-empty">{t("files.loadingOfficePreview")}</div>}
      {status === "error" && (
        <div className="remote-file-error">
          <span>{error || t("files.officeLoadFailed")}</span>
          <small>{t("files.officeUnsupportedHint")}</small>
        </div>
      )}
      {format === "spreadsheet" && status === "ready" && (
        <div className="remote-office-spreadsheet">
          {sheets.length > 0 ? (
            <>
              <div className="remote-office-sheet-tabs" role="tablist" aria-label={t("files.officeWorksheets")}>
                {sheets.map((sheet, index) => (
                  <button
                    key={sheet.name}
                    type="button"
                    role="tab"
                    aria-selected={index === activeSheetIndex}
                    onClick={() => setActiveSheetIndex(index)}
                  >
                    {sheet.name}
                  </button>
                ))}
              </div>
              {activeSheet?.truncated && <div className="remote-office-warning">{t("files.officeSpreadsheetTruncated")}</div>}
              <div className="remote-office-sheet-viewport">
                <table aria-label={`${fileName} - ${activeSheet?.name || ""}`}>
                  <colgroup>{columnGroup}</colgroup>
                  <tbody>
                    {activeSheet?.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell) => cell.hidden ? null : (
                          <td key={cell.key} rowSpan={cell.rowSpan} colSpan={cell.colSpan} style={cell.style}>{cell.text}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : <div className="remote-file-empty">{t("files.officeEmptyWorkbook")}</div>}
        </div>
      )}
      <div ref={renderHostRef} className="remote-office-render-host" hidden={format === "spreadsheet" || status === "error"} />
    </div>
  );
}
