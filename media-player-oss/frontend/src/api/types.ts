export interface ConfigResponse {
  oss_ready: boolean;
  oss_missing: string[];
  bucket: string;
  prefix: string;
}

export interface CatalogInfo {
  title?: string;
  artist?: string;
  duration?: number;
  source?: string;
  source_host?: string;
}

export interface Metadata {
  title: string;
  artist: string;
  favorite: boolean;
}

export interface Track extends Metadata {
  key: string;
  name: string;
  size: number;
  last_modified: string;
  info: CatalogInfo;
}

export interface TracksResponse {
  tracks: Track[];
  prefix: string;
  truncated: boolean;
  catalog_error: string | null;
}

export interface MetadataChanges {
  title?: string | null;
  artist?: string | null;
  favorite?: boolean | null;
}

export interface MetadataInput extends MetadataChanges { key: string }
export interface MetadataResponse extends Metadata { key: string }
export type SortOrder = 'recent' | 'title' | 'artist';
export type LibraryView = 'all' | 'favorites';
export type RepeatMode = 'all' | 'one' | 'off';
