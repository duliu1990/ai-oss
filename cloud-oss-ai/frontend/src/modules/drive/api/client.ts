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
import { isConfig } from '../../../shared/api/config';
import {
  ApiError,
  HttpClient,
  invalidResponse,
  isAbort,
  isFiniteNumber,
  isRecord,
  withAbort,
} from '../../../shared/api/http';
import type { AuthPort } from '../../../shared/api/http';
import { initialBase, tokens } from '../../../shared/session';

export { ApiError, endpoint, errorMessage, isAbort } from '../../../shared/api/http';

const REQUEST_TIMEOUT = 20_000;
const UPLOAD_TIMEOUT = 5 * 60_000;

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

export class DriveApi extends HttpClient {
  constructor(
    base: string,
    fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    // Default to the page's shared session so every drive view sees one login.
    auth: AuthPort = tokens,
  ) {
    super(base, fetcher, auth);
  }

  protected override get unreachableMessage(): string {
    return '无法连接文件服务，请检查网络和服务状态。';
  }

  async config(signal?: AbortSignal): Promise<ConfigResponse> {
    const value = await this.request('/api/config', {}, signal);
    if (!isConfig(value)) invalidResponse();
    return value;
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

  async notes(folder = '', signal?: AbortSignal): Promise<NotesResponse> {
    const query = folder ? `?${new URLSearchParams({ folder }).toString()}` : '';
    const value = await this.request(`/api/notes${query}`, {}, signal);
    if (!isRecord(value)
      || typeof value.prefix !== 'string'
      || typeof value.folder !== 'string'
      || !Array.isArray(value.folders)
      || !value.folders.every((entry) => isRecord(entry)
        && typeof entry.prefix === 'string'
        && typeof entry.name === 'string')
      || !Array.isArray(value.notes)
      || !value.notes.every(isNote)) invalidResponse();
    return value as unknown as NotesResponse;
  }

  async createNote(name: string, folder = '', content = '', signal?: AbortSignal): Promise<FileWriteResponse> {
    const value = await this.request('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder, content }),
    }, signal);
    if (!isRecord(value)
      || typeof value.key !== 'string'
      || typeof value.etag !== 'string'
      || !isFiniteNumber(value.size)) invalidResponse();
    return value as unknown as FileWriteResponse;
  }

  async createNoteFolder(folder: string, name: string, signal?: AbortSignal): Promise<FolderResponse> {
    const value = await this.request('/api/notes/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder, name }),
    }, signal);
    if (!isRecord(value) || typeof value.prefix !== 'string') invalidResponse();
    return value as unknown as FolderResponse;
  }

  async deleteNoteFolder(prefix: string, signal?: AbortSignal): Promise<DeleteFolderResponse> {
    const value = await this.request(
      `/api/notes/folder?${new URLSearchParams({ prefix }).toString()}`,
      { method: 'DELETE' },
      signal,
    );
    if (!isRecord(value) || !isFiniteNumber(value.deleted)) invalidResponse();
    return value as unknown as DeleteFolderResponse;
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
    const value = await this.request('/api/files/upload', { method: 'POST', body: form }, signal, { timeoutMs: UPLOAD_TIMEOUT });
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
      { timeoutMs: UPLOAD_TIMEOUT },
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
    return this.authorizedUrl('/api/files/download', params);
  }

  async text(key: string, signal?: AbortSignal): Promise<string> {
    const abort = withAbort(REQUEST_TIMEOUT, signal);
    try {
      const token = this.auth.token();
      const response = await this.fetcher(this.downloadUrl(key), {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: abort.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!response.ok) {
        if (response.status === 401) this.auth.onUnauthorized();
        throw new ApiError(`无法读取文件（${response.status}）`, response.status);
      }
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

export const api = new DriveApi(initialBase ?? '');
