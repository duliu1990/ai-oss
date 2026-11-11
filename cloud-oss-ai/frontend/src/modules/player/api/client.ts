import { HttpClient, invalidResponse, isRecord as record } from '../../../shared/api/http';
import { isConfig } from '../../../shared/api/config';
import type { ConfigResponse } from '../../../shared/api/config';
import type { CatalogInfo, MetadataInput, MetadataResponse, TracksResponse } from './types';

export { ApiError, endpoint, errorMessage, isAbort } from '../../../shared/api/http';
export type { AuthPort } from '../../../shared/api/http';
export { isConfig };

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

export class PlayerApi extends HttpClient {
  protected override get unreachableMessage(): string {
    return '无法连接播放服务，请检查网络和服务地址。';
  }

  /** <audio> cannot send headers, so the stream carries its token in the query string. */
  streamUrl(key: string): string {
    return this.authorizedUrl('/api/stream', { key });
  }

  async config(signal?: AbortSignal): Promise<ConfigResponse> {
    const value = await this.request('/api/config', {}, signal);
    if (!isConfig(value)) invalidResponse();
    return value;
  }

  async tracks(signal?: AbortSignal): Promise<TracksResponse> {
    const value = await this.request('/api/tracks', {}, signal);
    if (!Array.isArray(value.tracks) || typeof value.prefix !== 'string'
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
      headers: { 'Content-Type': 'application/json' },
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
        // An expired session surfaces here first when a track fails mid-playback.
        if (response.status === 401) this.auth.onUnauthorized();
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
