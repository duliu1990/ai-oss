import type { CatalogInfo, ConfigResponse, MetadataInput, MetadataResponse, TracksResponse } from './types';

export class ApiError extends Error {
  constructor(message: string, public readonly status = 0) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请重试。';
}

export function endpoint(base: string, path: string, params?: Record<string, string>): string {
  const query = params ? `?${new URLSearchParams(params)}` : '';
  return `${base}${path}${query}`;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function invalidResponse(): never {
  throw new ApiError('服务返回了无效的数据，请检查连接地址。');
}

function metadata(value: unknown): value is MetadataResponse {
  return record(value) && typeof value.key === 'string' && typeof value.title === 'string'
    && typeof value.artist === 'string' && typeof value.favorite === 'boolean';
}

function catalog(value: unknown): CatalogInfo {
  if (!record(value)) return {};
  const info: CatalogInfo = {};
  for (const key of ['title', 'artist', 'source', 'source_host'] as const) {
    if (typeof value[key] === 'string') info[key] = value[key];
  }
  if (typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration >= 0) {
    info.duration = value.duration;
  }
  return info;
}

export class ApiClient {
  constructor(
    readonly base: string,
    // Native browser fetch rejects an ApiClient receiver; call it on its global owner.
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  streamUrl(key: string): string { return endpoint(this.base, '/api/stream', { key }); }

  private async request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; abort(); }, 20000);
    try {
      const response = await this.fetcher(endpoint(this.base, path), {
        ...init, signal: controller.signal, credentials: 'omit', cache: 'no-store',
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = record(data) && typeof data.detail === 'string' ? data.detail : `请求失败（${response.status}）`;
        throw new ApiError(detail, response.status);
      }
      if (!record(data)) invalidResponse();
      return data;
    } catch (error) {
      if (timedOut) throw new ApiError('连接超时，请检查网络后重试。');
      if (isAbort(error) || error instanceof ApiError) throw error;
      throw new ApiError('无法连接播放服务，请检查网络和服务地址。');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async config(signal?: AbortSignal): Promise<ConfigResponse> {
    const value = await this.request('/api/config', {}, signal);
    if (!record(value) || typeof value.oss_ready !== 'boolean' || !Array.isArray(value.oss_missing)
      || !value.oss_missing.every((item) => typeof item === 'string')
      || typeof value.bucket !== 'string' || typeof value.prefix !== 'string') invalidResponse();
    return value as unknown as ConfigResponse;
  }

  async tracks(signal?: AbortSignal): Promise<TracksResponse> {
    const value = await this.request('/api/tracks', {}, signal);
    if (!record(value) || !Array.isArray(value.tracks) || typeof value.prefix !== 'string'
      || typeof value.truncated !== 'boolean'
      || !(value.catalog_error === null || typeof value.catalog_error === 'string')) invalidResponse();
    const tracks = value.tracks.map((track: unknown) => {
      if (!metadata(track) || !record(track) || typeof track.name !== 'string'
        || typeof track.size !== 'number' || !Number.isFinite(track.size)
        || typeof track.last_modified !== 'string') invalidResponse();
      return {
        key: track.key, name: track.name, size: track.size, last_modified: track.last_modified,
        title: track.title, artist: track.artist, favorite: track.favorite, info: catalog(track.info),
      };
    });
    return { tracks, prefix: value.prefix, truncated: value.truncated, catalog_error: value.catalog_error };
  }

  async updateMetadata(input: MetadataInput, signal?: AbortSignal): Promise<MetadataResponse> {
    const value = await this.request('/api/tracks/meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Player-Client': 'web' },
      // Keep null, omission, and empty strings distinct; catalog fields never enter this payload.
      body: JSON.stringify(input),
    }, signal);
    if (!metadata(value) || value.key !== input.key) invalidResponse();
    return value;
  }

  async describeStreamError(key: string, signal: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 8000);
    try {
      const response = await this.fetcher(this.streamUrl(key), {
        headers: { Range: 'bytes=0-1' }, credentials: 'omit', cache: 'no-store', signal: controller.signal,
      });
      if (!response.ok) {
        const data: unknown = await response.json().catch(() => null);
        return record(data) && typeof data.detail === 'string' ? data.detail : `服务返回 ${response.status}`;
      }
      // A server may ignore Range and return 200; never download the whole track for diagnosis.
      await response.body?.cancel();
      return '浏览器无法解码该音频文件。';
    } catch (error) {
      if (signal.aborted) throw error;
      return '无法连接播放服务，请检查网络。';
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}
