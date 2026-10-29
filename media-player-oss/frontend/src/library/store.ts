import { ApiClient, errorMessage, isAbort } from '../api/client';
import type { ConfigResponse, MetadataChanges, MetadataResponse, Track } from '../api/types';
import { saveOrigin, validateOrigin } from '../platform/connection';
import type { ConnectionPolicy, StorageLike } from '../platform/connection';
import { PlayerEngine } from '../player/engine';
import { visibleTracks } from './metadata';

export interface LibrarySnapshot {
  base: string | null;
  tracks: readonly Track[];
  config: ConfigResponse | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  pending: ReadonlySet<string>;
}

export interface LibraryOptions {
  native: boolean;
  base: string | null;
  policy: ConnectionPolicy;
  storage?: StorageLike;
}

export class LibraryStore {
  private snapshot: LibrarySnapshot;
  private listeners = new Set<() => void>();
  private session = 0;
  private refreshId = 0;
  private refreshAbort?: AbortController;
  private writes = new Map<string, AbortController>();
  private metadataRevision = 0;
  private latestMetadata = new Map<string, { revision: number; entry: MetadataResponse }>();
  private client: ApiClient;

  constructor(
    readonly player: PlayerEngine,
    private readonly options: LibraryOptions,
    private readonly makeClient: (base: string) => ApiClient = (base) => new ApiClient(base),
  ) {
    this.client = makeClient(options.base || '');
    this.snapshot = {
      base: options.base, tracks: [], config: null, loading: false, error: null, notice: null, pending: new Set(),
    };
  }

  getSnapshot = (): LibrarySnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private emit(patch: Partial<LibrarySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  refresh = async (): Promise<void> => {
    if (this.snapshot.base === null) return;
    this.refreshAbort?.abort();
    const abort = new AbortController();
    this.refreshAbort = abort;
    const session = this.session;
    const request = ++this.refreshId;
    const revision = this.metadataRevision;
    const client = this.client;
    const active = () => session === this.session && request === this.refreshId && !abort.signal.aborted;
    this.emit({ loading: true, error: null });
    try {
      const config = await client.config(abort.signal);
      if (!active()) return;
      this.emit({ config });
      if (!config.oss_ready) {
        // Missing configuration is not evidence that the saved track was removed.
        if (this.player.getSnapshot().currentKey) this.player.stop();
        this.emit({ tracks: [], notice: null, error: `OSS 尚未配置完整（缺少 ${config.oss_missing.join(', ')}）。请联系服务维护者。` });
        return;
      }
      const data = await client.tracks(abort.signal);
      if (!active()) return;
      // Do not let a listing begun before a completed write roll back that edit.
      const tracks = data.tracks.map((track) => {
        const latest = this.latestMetadata.get(track.key);
        return latest && latest.revision > revision ? { ...track, ...latest.entry } : track;
      });
      const existing = new Set(tracks.map((track) => track.key));
      for (const key of this.latestMetadata.keys()) if (!existing.has(key)) this.latestMetadata.delete(key);
      this.emit({
        tracks,
        notice: [data.catalog_error, data.truncated ? '文件数量超过列举上限，只显示了最近的部分音频。' : ''].filter(Boolean).join(' ') || null,
      });
      const sorted = visibleTracks(tracks, 'all', '', this.player.getSnapshot().sort);
      this.player.setLibrary(tracks.map((track) => track.key), sorted.map((track) => track.key));
    } catch (error) {
      if (active() && !isAbort(error)) this.emit({ error: errorMessage(error) });
    } finally {
      if (active()) this.emit({ loading: false });
    }
  };

  async updateMetadata(key: string, changes: MetadataChanges): Promise<void> {
    if (!this.snapshot.tracks.some((track) => track.key === key)) return;
    if (this.writes.has(key)) throw new Error('这首歌的信息正在保存，请稍候。');
    const session = this.session;
    const controller = new AbortController();
    this.writes.set(key, controller);
    this.emit({ pending: new Set(this.writes.keys()) });
    try {
      const entry = await this.client.updateMetadata({ key, ...changes }, controller.signal);
      if (session !== this.session || controller.signal.aborted) throw new DOMException('Service changed', 'AbortError');
      this.latestMetadata.set(key, { revision: ++this.metadataRevision, entry });
      this.emit({ tracks: this.snapshot.tracks.map((track) => track.key === key ? { ...track, ...entry } : track) });
    } finally {
      if (session === this.session) {
        this.writes.delete(key);
        this.emit({ pending: new Set(this.writes.keys()) });
      }
    }
  }

  connect(input: string): boolean {
    if (!this.options.native) throw new Error('网页版始终连接当前站点。');
    const base = validateOrigin(input, this.options.policy);
    const persisted = saveOrigin(base, this.options.storage);
    if (base !== this.snapshot.base) {
      this.invalidateRequests();
      this.client = this.makeClient(base);
      this.latestMetadata.clear();
      this.metadataRevision = 0;
      // Stop and invalidate media before exposing the new service to React.
      this.player.switchService(this.client, base);
      this.emit({ base, tracks: [], config: null, error: null, notice: null, loading: false, pending: new Set() });
    }
    void this.refresh();
    return persisted;
  }

  private invalidateRequests(): void {
    ++this.session;
    ++this.refreshId;
    this.refreshAbort?.abort();
    this.writes.forEach((controller) => controller.abort());
    this.writes.clear();
  }

  dispose(): void {
    this.invalidateRequests();
    this.listeners.clear();
  }
}
