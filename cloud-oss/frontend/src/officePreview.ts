import type { Options as DocxPreviewOptions } from 'docx-preview';
import type { CellObject, WorkBook, XLSX$Utils } from 'xlsx';
import type { DriveItem } from './api/types';

export type OfficeExtension = 'docx' | 'xlsx' | 'pptx';

const OFFICE_EXTENSIONS = new Set<OfficeExtension>(['docx', 'xlsx', 'pptx']);

export const MAX_OFFICE_FILE_BYTES = 25 * 1024 * 1024;

export const DOCX_RENDER_OPTIONS = {
  breakPages: true,
  className: 'office-docx',
  ignoreFonts: false,
  inWrapper: true,
  renderAltChunks: false,
  renderFooters: true,
  renderFootnotes: true,
  renderHeaders: true,
} satisfies Partial<DocxPreviewOptions>;

export interface PreviewRequest {
  key: string;
  name: string;
  type: OfficeExtension | null;
}

export interface SpreadsheetSheetData {
  name: string;
  rows: Record<string, unknown>;
  cols: Record<string, unknown>;
  merges: string[];
}

export interface ContainSize {
  height: number;
  scale: number;
  width: number;
}

export function calculateContainSize(
  availableWidth: number,
  availableHeight: number,
  contentWidth: number,
  contentHeight: number,
): ContainSize {
  if (availableWidth <= 0 || availableHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
    return { height: 0, scale: 0, width: 0 };
  }
  const scale = Math.min(availableWidth / contentWidth, availableHeight / contentHeight);
  return { height: contentHeight * scale, scale, width: contentWidth * scale };
}

function pptxSlideSize(slide: HTMLElement): { height: number; width: number } | null {
  const width = Number.parseFloat(slide.style.width) || slide.offsetWidth;
  const height = Number.parseFloat(slide.style.height) || slide.offsetHeight;
  return width > 0 && height > 0 ? { height, width } : null;
}

export function applyPptxContainLayout(stage: HTMLElement, host: HTMLElement): void {
  const wrapper = host.querySelector<HTMLElement>('.pptx-preview-wrapper');
  const slides = Array.from(host.querySelectorAll<HTMLElement>('.pptx-preview-slide-wrapper'));
  const naturalSize = slides[0] ? pptxSlideSize(slides[0]) : null;
  if (!wrapper || !naturalSize) return;

  const fitted = calculateContainSize(
    stage.clientWidth,
    stage.clientHeight,
    naturalSize.width,
    naturalSize.height,
  );
  if (fitted.scale === 0) return;

  wrapper.classList.add('office-pptx-pages');
  for (const slide of slides) {
    let page = slide.parentElement;
    if (!page?.classList.contains('office-pptx-page')) {
      page = document.createElement('div');
      page.className = 'office-pptx-page';
      slide.before(page);
      page.append(slide);
    }
    page.style.width = `${fitted.width}px`;
    page.style.height = `${fitted.height}px`;
    slide.style.transform = `scale(${fitted.scale})`;
  }
}

export function observePptxContainLayout(stage: HTMLElement, host: HTMLElement): () => void {
  let animationFrame = 0;
  let disposed = false;
  let domChanged = true;
  let lastHeight = -1;
  let lastWidth = -1;
  const layout = () => {
    animationFrame = 0;
    if (disposed) return;
    const height = stage.clientHeight;
    const width = stage.clientWidth;
    if (!domChanged && width === lastWidth && height === lastHeight) return;
    domChanged = false;
    lastWidth = width;
    lastHeight = height;
    applyPptxContainLayout(stage, host);
  };
  const scheduleLayout = (afterDomChange = false) => {
    if (afterDomChange) domChanged = true;
    if (!disposed && animationFrame === 0) animationFrame = requestAnimationFrame(layout);
  };
  const resizeObserver = new ResizeObserver(() => scheduleLayout());
  const mutationObserver = new MutationObserver(() => scheduleLayout(true));
  resizeObserver.observe(stage);
  mutationObserver.observe(host, { childList: true, subtree: true });
  scheduleLayout(true);

  return () => {
    disposed = true;
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
  };
}

const EXCEL_ERROR_TEXT: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
  0x2b: '#GETTING_DATA',
};

export function fileExtension(name: string): string {
  const separator = name.lastIndexOf('.');
  return separator >= 0 ? name.slice(separator + 1).toLowerCase() : '';
}

export function officeExtension(name: string): OfficeExtension | null {
  const value = fileExtension(name);
  return OFFICE_EXTENSIONS.has(value as OfficeExtension) ? value as OfficeExtension : null;
}

export function officePreviewRequest(search = globalThis.location.search): PreviewRequest {
  const params = new URLSearchParams(search);
  const key = params.get('key') ?? '';
  const suppliedName = params.get('name')?.trim() ?? '';
  const keyName = key.split('/').filter(Boolean).at(-1)?.trim() ?? '';
  const name = suppliedName || keyName || 'Office 文件';
  return { key, name, type: officeExtension(suppliedName || keyName) };
}

export function assertOfficeFileSize(byteLength: number): void {
  if (byteLength > MAX_OFFICE_FILE_BYTES) {
    throw new Error('文件超过 25 MiB 安全预览上限，请下载后在本地打开。');
  }
}

export function assertXlsxZipSignature(data: ArrayBuffer): void {
  const signature = new Uint8Array(data, 0, Math.min(2, data.byteLength));
  if (signature.length < 2 || signature[0] !== 0x50 || signature[1] !== 0x4b) {
    throw new Error('文件不是有效的 .xlsx OOXML 工作簿，请下载后在本地检查。');
  }
}

function spreadsheetCellText(value: unknown, cell: CellObject | undefined): string | null {
  if (cell?.t === 'e') {
    return cell.w || EXCEL_ERROR_TEXT[Number(cell.v)] || '#ERROR!';
  }
  return value === '' ? null : String(value);
}

export function workbookToSpreadsheetData(workbook: WorkBook, utils: XLSX$Utils): SpreadsheetSheetData[] {
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const matrix = utils.sheet_to_json<unknown[]>(sheet, {
      defval: '',
      header: 1,
      raw: false,
    });
    const range = sheet['!ref'] ? utils.decode_range(sheet['!ref']) : null;
    const rowOffset = range?.s.r ?? 0;
    const columnOffset = range?.s.c ?? 0;
    const rows: Record<string, unknown> = {
      len: Math.max((range?.e.r ?? -1) + 1, rowOffset + matrix.length, 30),
    };
    matrix.forEach((values, rowIndex) => {
      const cells: Record<string, { text: string }> = {};
      values.forEach((value, columnIndex) => {
        const row = rowOffset + rowIndex;
        const column = columnOffset + columnIndex;
        const cell = sheet[utils.encode_cell({ r: row, c: column })] as CellObject | undefined;
        const text = spreadsheetCellText(value, cell);
        if (text !== null) cells[column] = { text };
      });
      if (Object.keys(cells).length) rows[rowOffset + rowIndex] = { cells };
    });
    const cols: Record<string, unknown> = {
      len: Math.max((range?.e.c ?? -1) + 1, 12),
    };
    sheet['!cols']?.forEach((column, index) => {
      if (column.wpx || column.wch) {
        cols[index] = { width: column.wpx ?? Math.round((column.wch ?? 10) * 7 + 14) };
      }
    });
    return {
      name,
      rows,
      cols,
      merges: sheet['!merges']?.map((merge) => utils.encode_range(merge)) ?? [],
    };
  });
}

export function isOfficeFile(item: DriveItem): boolean {
  return !item.isDir && officeExtension(item.name) !== null;
}

export function officePreviewUrl(item: Pick<DriveItem, 'key' | 'name'>): string {
  const query = new URLSearchParams({
    'office-preview': '1',
    key: item.key,
    name: item.name,
  });
  return `/?${query.toString()}`;
}
