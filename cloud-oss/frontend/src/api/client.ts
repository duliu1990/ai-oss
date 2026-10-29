import type {
  ConfigResponse,
  CreateFileRequest,
  DeleteFolderResponse,
  EditableFileResponse,
  FilesResponse,
  FileEntry,
  FileWriteResponse,
  FolderResponse,
  NoteEntry,
  NotesResponse,
  OkResponse,
  SearchResponse,
  TransferResponse,
  UpdateFileRequest,
  UploadInitResponse,
  UploadPart,
  UploadPartResponse,
  UploadResponse,
} from './types';
import { clearAuthToken, getAuthToken } from '../hooks/useAuth';

const REQUEST_TIMEOUT = 20_000;
const UPLOAD_TIMEOUT = 5 * 60_000;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  if (isAbort(error)) return '操作已取消。';
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

export function endpoint(base: string, path: string, params?: Record<string, string>): string {
  const query = params ? `?${new URLSearchParams(params).toString()}` : '';
  return `${base}${path}${query}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function invalidResponse(): never {
  throw new ApiError('服务返回了无法识别的数据。');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFile(value: unknown): value is FileEntry {
  return isRecord(value)
    && typeof value.key === 'string'
    && typeof value.name === 'string'
    && isFiniteNumber(value.size)
    && value.size >= 0
    && typeof value.last_modified === 'string'
    && typeof value.is_dir === 'boolean';
}

function isNote(value: unknown): value is NoteEntry {
  return isRecord(value)
    && typeof value.key === 'string'
    && typeof value.name === 'string'
    && typeof value.folder === 'string'
    && isFiniteNumber(value.size)
    && value.size >= 0
    && typeof value.last_modified === 'string';
}

function withAbort(timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

export class ApiClient {
  constructor(
    readonly base: string,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  private async request(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT,
  ): Promise<unknown> {
    const abort = withAbort(timeoutMs, signal);
    try {
      const headers = new Headers(init.headers);
      const token = getAuthToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const response = await this.fetcher(endpoint(this.base, path), {
        ...init,
        headers,
        signal: abort.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      if (response.status === 401) {
        clearAuthToken();
        window.location.reload();
        throw new ApiError('登录已过期', 401);
      }
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = isRecord(data) && typeof data.detail === 'string'
          ? data.detail
          : `请求失败（${response.status}）`;
        throw new ApiError(detail, response.status, isRecord(data) ? data : null);
      }
      if (!isRecord(data)) invalidResponse();
      return data;
    } catch (error) {
      if (abort.timedOut()) throw new ApiError('连接超时，请检查网络后重试。');
      if (isAbort(error) || error instanceof ApiError) throw error;
      throw new ApiError('无法连接文件服务，请检查网络和服务状态。');
    } finally {
      abort.dispose();
    }
  }

  async config(signal?: AbortSignal): Promise<ConfigResponse> {
    const value = await this.request('/api/config', {}, signal);
    if (!isRecord(value)
      || typeof value.bucket !== 'string'
      || typeof value.prefix !== 'string'
      || !isFiniteNumber(value.port)) invalidResponse();
    return value as unknown as ConfigResponse;
  }

  async files(prefix: string, marker = '', signal?: AbortSignal): Promise<FilesResponse> {
    const params: Record<string, string> = { prefix };
    if (marker) params.marker = marker;
    const value = await this.request(`/api/files?${new URLSearchParams(params).toString()}`, {}, signal);
    if (!isRecord(value)
      || !Array.isArray(value.files)
      || !value.files.every(isFile)
      || !Array.isArray(value.folders)
      || !value.folders.every((folder) => isRecord(folder)
        && typeof folder.prefix === 'string'
        && typeof folder.name === 'string')
      || !(value.next_marker === null || typeof value.next_marker === 'string')
      || typeof value.truncated !== 'boolean') invalidResponse();
    return value as unknown as FilesResponse;
  }

  async search(query: string, prefix: string, signal?: AbortSignal): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query, prefix });
    const value = await this.request(`/api/files/search?${params.toString()}`, {}, signal);
    if (!isRecord(value) || !Array.isArray(value.results) || !value.results.every(isFile)) invalidResponse();
    return value as unknown as SearchResponse;
  }

  async notes(signal?: AbortSignal): Promise<NotesResponse> {
    const value = await this.request('/api/notes', {}, signal);
    if (!isRecord(value)
      || typeof value.prefix !== 'string'
      || !Array.isArray(value.notes)
      || !value.notes.every(isNote)) invalidResponse();
    return value as unknown as NotesResponse;
  }

  async createNote(name: string, content = '', signal?: AbortSignal): Promise<FileWriteResponse> {
    const value = await this.request('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content }),
    }, signal);
    if (!isRecord(value)
      || typeof value.key !== 'string'
      || typeof value.etag !== 'string'
      || !isFiniteNumber(value.size)) invalidResponse();
    return value as unknown as FileWriteResponse;
  }

  async readNote(key: string, signal?: AbortSignal): Promise<EditableFileResponse> {
    const value = await this.request(`/api/notes/content?${new URLSearchParams({ key }).toString()}`, {}, signal);
    if (!isRecord(value)
      || typeof value.key !== 'string'
      || typeof value.content !== 'string'
      || typeof value.etag !== 'string'
      || !isFiniteNumber(value.size)
      || typeof value.content_type !== 'string') invalidResponse();
    return value as unknown as EditableFileResponse;
  }

  async updateNote(request: UpdateFileRequest, signal?: AbortSignal): Promise<FileWriteResponse> {
    const value = await this.request('/api/notes', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }, signal);
    if (!isRecord(value)
      || typeof value.key !== 'string'
      || typeof value.etag !== 'string'
      || !isFiniteNumber(value.size)) invalidResponse();
    return value as unknown as FileWriteResponse;
  }

  async deleteNote(key: string, signal?: AbortSignal): Promise<OkResponse> {
    const value = await this.request(`/api/notes?${new URLSearchParams({ key }).toString()}`, {
      method: 'DELETE',
    }, signal);
    if (!isRecord(value) || value.ok !== true) invalidResponse();
    return value as unknown as OkResponse;
  }

  async upload(file: File, key: string, signal?: AbortSignal): Promise<UploadResponse> {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('key', key);
    const value = await this.request('/api/files/upload', { method: 'POST', body: form }, signal, UPLOAD_TIMEOUT);
    if (!isRecord(value) || typeof value.key !== 'string' || !isFiniteNumber(value.size)) invalidResponse();
    return value as unknown as UploadResponse;
  }

  async initUpload(key: string, size: number, signal?: AbortSignal): Promise<UploadInitResponse> {
    const value = await this.request('/api/files/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, size }),
    }, signal);
    if (!isRecord(value) || typeof value.upload_id !== 'string' || typeof value.key !== 'string') invalidResponse();
    return value as unknown as UploadInitResponse;
  }

  async uploadPart(
    uploadId: string,
    part: number,
    body: Blob,
    signal?: AbortSignal,
  ): Promise<UploadPartResponse> {
    const value = await this.request(
      `/api/files/upload/${encodeURIComponent(uploadId)}/${part}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body },
      signal,
      UPLOAD_TIMEOUT,
    );
    if (!isRecord(value) || !isFiniteNumber(value.part_number) || typeof value.etag !== 'string') invalidResponse();
    return value as unknown as UploadPartResponse;
  }

  async completeUpload(uploadId: string, parts: UploadPart[], signal?: AbortSignal): Promise<UploadResponse> {
    const value = await this.request(`/api/files/upload/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts }),
    }, signal);
    if (!isRecord(value) || typeof value.key !== 'string' || !isFiniteNumber(value.size)) invalidResponse();
    return value as unknown as UploadResponse;
  }

  async cancelUpload(uploadId: string, signal?: AbortSignal): Promise<OkResponse> {
    const value = await this.request(
      `/api/files/upload/${encodeURIComponent(uploadId)}`,
      { method: 'DELETE' },
      signal,
    );
    if (!isRecord(value) || value.ok !== true) invalidResponse();
    return value as unknown as OkResponse;
  }

  async deleteFile(key: string, signal?: AbortSignal): Promise<OkResponse> {
    const value = await this.request(`/api/files?${new URLSearchParams({ key }).toString()}`, {
      method: 'DELETE',
    }, signal);
    if (!isRecord(value) || value.ok !== true) invalidResponse();
    return value as unknown as OkResponse;
  }

  async deleteFolder(prefix: string, signal?: AbortSignal): Promise<DeleteFolderResponse> {
    const value = await this.request(`/api/files/folder?${new URLSearchParams({ prefix }).toString()}`, {
      method: 'DELETE',
    }, signal);
    if (!isRecord(value) || !isFiniteNumber(value.deleted)) invalidResponse();
    return value as unknown as DeleteFolderResponse;
  }

  async createFolder(prefix: string, signal?: AbortSignal): Promise<FolderResponse> {
    const value = await this.request('/api/files/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix }),
    }, signal);
    if (!isRecord(value) || typeof value.prefix !== 'string') invalidResponse();
    return value as unknown as FolderResponse;
  }

  async createFile(request: CreateFileRequest, signal?: AbortSignal): Promise<FileWriteResponse> {
    const value = await this.request('/api/files/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }, signal);
    if (!isRecord(value)
      || typeof value.key !== 'string'
      || typeof value.etag !== 'string'
      || !isFiniteNumber(value.size)) invalidResponse();
    return value as unknown as FileWriteResponse;
  }

  async editFile(key: string, signal?: AbortSignal): Promise<EditableFileResponse> {
    const value = await this.request(`/api/files/edit?${new URLSearchParams({ key }).toString()}`, {}, signal);
    if (!isRecord(value)
      || typeof value.key !== 'string'
      || typeof value.content !== 'string'
      || typeof value.etag !== 'string'
      || !isFiniteNumber(value.size)
      || typeof value.content_type !== 'string') invalidResponse();
    return value as unknown as EditableFileResponse;
  }

  async updateFile(request: UpdateFileRequest, signal?: AbortSignal): Promise<FileWriteResponse> {
    const value = await this.request('/api/files/edit', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }, signal);
    if (!isRecord(value)
      || typeof value.key !== 'string'
      || typeof value.etag !== 'string'
      || !isFiniteNumber(value.size)) invalidResponse();
    return value as unknown as FileWriteResponse;
  }

  async rename(key: string, newName: string, signal?: AbortSignal): Promise<TransferResponse> {
    const value = await this.request('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, new_name: newName }),
    }, signal);
    if (!isRecord(value) || typeof value.old_key !== 'string' || typeof value.new_key !== 'string') invalidResponse();
    return value as unknown as TransferResponse;
  }

  async move(key: string, destination: string, signal?: AbortSignal): Promise<TransferResponse> {
    const value = await this.request('/api/files/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, destination }),
    }, signal);
    if (!isRecord(value) || typeof value.old_key !== 'string' || typeof value.new_key !== 'string') invalidResponse();
    return value as unknown as TransferResponse;
  }

  downloadUrl(key: string, download = false): string {
    const params: Record<string, string> = { key };
    if (download) params.download = 'true';
    const url = endpoint(this.base, '/api/files/download', params);
    const token = getAuthToken();
    return token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url;
  }

  async text(key: string, signal?: AbortSignal): Promise<string> {
    const abort = withAbort(REQUEST_TIMEOUT, signal);
    try {
      const token = getAuthToken();
      const response = await this.fetcher(this.downloadUrl(key), {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: abort.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok) throw new ApiError(`无法读取文件（${response.status}）`, response.status);
      return await response.text();
    } catch (error) {
      if (abort.timedOut()) throw new ApiError('文件预览加载超时。');
      if (isAbort(error) || error instanceof ApiError) throw error;
      throw new ApiError('无法加载文件预览。');
    } finally {
      abort.dispose();
    }
  }
}

export const api = new ApiClient('');
