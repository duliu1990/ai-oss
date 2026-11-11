import { ApiError } from './api/client';

export type RootApplication = 'app' | 'markdown-preview' | 'office-preview';

export interface MarkdownPreviewRequest {
  key: string;
  name: string;
  valid: boolean;
}

export function rootApplication(search = globalThis.location.search): RootApplication {
  const params = new URLSearchParams(search);
  if (params.get('office-preview') === '1') return 'office-preview';
  if (params.get('markdown-preview') === '1') return 'markdown-preview';
  return 'app';
}

export function isMarkdownName(name: string): boolean {
  return name.split('/').at(-1)?.toLowerCase().endsWith('.md') ?? false;
}

export function markdownPreviewUrl(item: { key: string; name: string }): string {
  const query = new URLSearchParams({
    'markdown-preview': '1',
    key: item.key,
    name: item.name,
  });
  return `/?${query.toString()}`;
}

export function markdownPreviewRequest(search = globalThis.location.search): MarkdownPreviewRequest {
  const params = new URLSearchParams(search);
  const key = params.get('key') ?? '';
  const suppliedName = params.get('name')?.trim() ?? '';
  const keyName = key.split('/').filter(Boolean).at(-1)?.trim() ?? '';
  return {
    key,
    name: suppliedName || keyName || 'Markdown 文件',
    valid: key.length > 0 && isMarkdownName(keyName),
  };
}

export function markdownPreviewError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return '文件不存在或已被删除。';
    if (error.status === 413) return '文件超过 1 MiB 在线预览上限，请下载后查看。';
    if (error.status === 400 && /utf-?8/i.test(error.message)) {
      return '文件不是有效的 UTF-8 文本，无法在线预览。';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : '网络请求失败，请稍后重试。';
}

export function neutralizeMarkdownMarkup(source: string): string {
  return source.replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g, '');
}

export function isSafeMarkdownLink(value: string): boolean {
  try {
    const url = new URL(value, globalThis.location.href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function secureLink(link: HTMLAnchorElement): void {
  const href = link.getAttribute('href');
  if (href !== null && !isSafeMarkdownLink(href)) link.removeAttribute('href');
  if (link.target !== '_blank') link.target = '_blank';
  if (link.rel !== 'noopener noreferrer') link.rel = 'noopener noreferrer';
}

export function hardenMarkdownLinks(container: HTMLElement): () => void {
  const secureEditable = (element: HTMLElement) => {
    if (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false') {
      element.setAttribute('contenteditable', 'false');
    }
  };
  const secureAll = (root: ParentNode) => {
    if (root instanceof HTMLAnchorElement) secureLink(root);
    if (root instanceof HTMLElement) secureEditable(root);
    root.querySelectorAll<HTMLAnchorElement>('a').forEach(secureLink);
    root.querySelectorAll<HTMLElement>('[contenteditable]').forEach(secureEditable);
  };
  secureAll(container);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof HTMLAnchorElement) secureLink(record.target);
        if (record.target instanceof HTMLElement) secureEditable(record.target);
        continue;
      }
      record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) secureAll(node);
      });
    }
  });
  observer.observe(container, {
    attributes: true,
    attributeFilter: ['contenteditable', 'href'],
    childList: true,
    subtree: true,
  });

  const guardClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a') : null;
    if (!target || !container.contains(target)) return;
    secureLink(target);
    if (!target.hasAttribute('href')) event.preventDefault();
  };
  container.addEventListener('click', guardClick);

  return () => {
    observer.disconnect();
    container.removeEventListener('click', guardClick);
  };
}
