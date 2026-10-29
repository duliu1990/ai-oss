import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import {
  assertOfficeFileSize,
  assertXlsxZipSignature,
  DOCX_RENDER_OPTIONS,
  observePptxContainLayout,
  officePreviewRequest,
  workbookToSpreadsheetData,
} from '../officePreview';
import type { OfficeExtension } from '../officePreview';
import { Icon } from './Icon';
import '../office-preview.css';

type PreviewStatus = 'loading' | 'rendering' | 'ready' | 'error';
type DisposeRenderer = () => void;

async function downloadBuffer(key: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await globalThis.fetch(api.downloadUrl(key), {
    cache: 'no-store',
    credentials: 'omit',
    signal,
  });
  if (!response.ok) throw new Error(`文件读取失败（${response.status}）`);
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength)) assertOfficeFileSize(declaredLength);
  const data = await response.arrayBuffer();
  assertOfficeFileSize(data.byteLength);
  return data;
}

async function renderDocx(data: ArrayBuffer, host: HTMLElement): Promise<DisposeRenderer> {
  const { renderAsync } = await import('docx-preview');
  await renderAsync(data, host, undefined, DOCX_RENDER_OPTIONS);
  return () => host.replaceChildren();
}

async function renderWorkbook(data: ArrayBuffer, host: HTMLElement): Promise<DisposeRenderer> {
  assertXlsxZipSignature(data);
  const [XLSX, spreadsheetModule] = await Promise.all([
    import('xlsx'),
    import('x-data-spreadsheet'),
  ]);
  const workbook = XLSX.read(data, { cellDates: true, type: 'array' });
  const sheets = workbookToSpreadsheetData(workbook, XLSX.utils);
  const Spreadsheet = spreadsheetModule.default;
  const spreadsheet = new Spreadsheet(host, {
    mode: 'read',
    showContextmenu: false,
    showToolbar: false,
    view: {
      height: () => Math.max(host.clientHeight, 480),
      width: () => Math.max(host.clientWidth, 720),
    },
  });
  spreadsheet.loadData(sheets as unknown as Record<string, unknown>);
  return () => host.replaceChildren();
}

async function renderPresentation(
  data: ArrayBuffer,
  host: HTMLElement,
  stage: HTMLElement,
): Promise<DisposeRenderer> {
  const { init } = await import('pptx-preview');
  const previewer = init(host, { height: 540, mode: 'list', width: 960 });
  try {
    await previewer.preview(data);
  } catch (error) {
    previewer.destroy();
    throw error;
  }
  const stopLayout = observePptxContainLayout(stage, host);
  return () => {
    stopLayout();
    previewer.destroy();
  };
}

async function renderOfficeFile(
  type: OfficeExtension,
  data: ArrayBuffer,
  host: HTMLElement,
  stage: HTMLElement,
): Promise<DisposeRenderer> {
  host.replaceChildren();
  try {
    if (type === 'docx') return await renderDocx(data, host);
    if (type === 'xlsx') return await renderWorkbook(data, host);
    return await renderPresentation(data, host, stage);
  } catch (error) {
    host.replaceChildren();
    throw error;
  }
}

const typeLabels: Record<OfficeExtension, string> = {
  docx: 'WORD 文档',
  pptx: 'POWERPOINT 演示文稿',
  xlsx: 'EXCEL 工作簿',
};

const typeIcons: Record<OfficeExtension, 'word' | 'sheet' | 'slides'> = {
  docx: 'word',
  pptx: 'slides',
  xlsx: 'sheet',
};

export function OfficePreviewApp() {
  const request = useMemo(officePreviewRequest, []);
  const stageRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<PreviewStatus>('loading');
  const [message, setMessage] = useState('正在安全读取文件…');

  useEffect(() => {
    document.title = request.name;
    const host = stageRef.current;
    if (!host) return undefined;
    host.replaceChildren();
    if (request.key.length === 0) {
      setStatus('error');
      setMessage('缺少文件地址，无法开始预览。');
      return undefined;
    }
    if (!request.type) {
      setStatus('error');
      setMessage('仅支持 .docx、.xlsx 和 .pptx 文件在线预览。');
      return undefined;
    }

    const controller = new AbortController();
    const renderHost = document.createElement('div');
    renderHost.className = 'office-render-host';
    host.replaceChildren(renderHost);
    let disposed = false;
    let disposeRenderer: DisposeRenderer | undefined;
    setStatus('loading');
    setMessage('正在安全读取文件…');
    void downloadBuffer(request.key, controller.signal)
      .then(async (data) => {
        if (controller.signal.aborted) return;
        setStatus('rendering');
        setMessage('正在还原文档版式…');
        const renderer = await renderOfficeFile(request.type!, data, renderHost, host);
        if (disposed || controller.signal.aborted) {
          renderer();
          renderHost.remove();
          return;
        }
        disposeRenderer = renderer;
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || disposed) return;
        setStatus('error');
        setMessage(error instanceof Error ? error.message : '预览失败，请稍后重试。');
      });

    return () => {
      disposed = true;
      controller.abort();
      disposeRenderer?.();
      renderHost.remove();
    };
  }, [request]);

  const download = () => {
    if (request.key.length === 0) return;
    const link = document.createElement('a');
    link.href = api.downloadUrl(request.key, true);
    link.download = request.name;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  };

  const typeLabel = request.type ? typeLabels[request.type] : 'OFFICE 文件';
  const icon = request.type ? typeIcons[request.type] : 'file';

  return (
    <main className={`office-preview-shell office-preview-shell-${request.type ?? 'unknown'}`}>
      <header className="office-preview-head">
        <div className={`office-preview-mark office-preview-mark-${request.type ?? 'unknown'}`}>
          <Icon name={icon} size={25} />
        </div>
        <div className="office-preview-heading">
          <span>{typeLabel} · 在线预览</span>
          <h1 title={request.name}>{request.name}</h1>
        </div>
        <button className="office-download" disabled={request.key.length === 0} onClick={download} type="button">
          <Icon name="download" size={17} />
          下载原文件
        </button>
      </header>

      <section aria-busy={status === 'loading' || status === 'rendering'} className={`office-preview-canvas office-preview-${request.type ?? 'unknown'}`}>
        <div className="office-render-stage" ref={stageRef} />
        {(status === 'loading' || status === 'rendering') && (
          <div aria-live="polite" className="office-preview-state office-preview-progress">
            <span className="office-loader" />
            <strong>{message}</strong>
            <p>复杂文档可能需要稍候片刻，请不要关闭此页面。</p>
          </div>
        )}
        {status === 'error' && (
          <div aria-live="assertive" className="office-preview-state office-preview-error">
            <span className="office-error-symbol">!</span>
            <strong>暂时无法显示此文件</strong>
            <p>{message}</p>
            <button disabled={request.key.length === 0} onClick={download} type="button">
              <Icon name="download" size={17} />下载后打开
            </button>
          </div>
        )}
      </section>
      <footer className="office-preview-foot">
        <span>轻存储文档阅读器</span>
        <span>文件仅通过当前文件服务读取，不会生成外部分享链接</span>
      </footer>
    </main>
  );
}
