import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { errorMessage, isAbort } from '../api/client';
import type { FileEntry, FolderEntry } from '../api/types';

interface FilesState {
  files: FileEntry[];
  folders: FolderEntry[];
  nextMarker: string | null;
  truncated: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
}

const initialState: FilesState = {
  files: [],
  folders: [],
  nextMarker: null,
  truncated: false,
  loading: true,
  loadingMore: false,
  error: null,
};

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

export function useFiles(client: ApiClient, prefix: string) {
  const [state, setState] = useState<FilesState>(initialState);
  const controllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const metadataPatchesRef = useRef(new Map<string, { size: number; last_modified: string }>());

  const load = useCallback(async (append = false, preserveVisible = false) => {
    const requestId = ++requestIdRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const marker = append ? state.nextMarker ?? '' : '';
    setState((current) => ({
      ...current,
      loading: !append && !preserveVisible,
      loadingMore: append,
      error: null,
      ...(append || preserveVisible ? {} : { files: [], folders: [], nextMarker: null, truncated: false }),
    }));
    try {
      const result = await client.files(prefix, marker, controller.signal);
      if (requestId !== requestIdRef.current) return;
      const refreshedFiles = result.files.map((file) => {
        const patch = metadataPatchesRef.current.get(file.key);
        if (!patch) return file;
        if (file.size === patch.size) {
          metadataPatchesRef.current.delete(file.key);
          return file;
        }
        return { ...file, ...patch };
      });
      setState((current) => ({
        files: append ? uniqueBy([...current.files, ...refreshedFiles], (file) => file.key) : refreshedFiles,
        folders: append
          ? uniqueBy([...current.folders, ...result.folders], (folder) => folder.prefix)
          : result.folders,
        nextMarker: result.next_marker,
        truncated: result.truncated,
        loading: false,
        loadingMore: false,
        error: null,
      }));
    } catch (error) {
      if (isAbort(error) || requestId !== requestIdRef.current) return;
      setState((current) => ({
        ...current,
        loading: false,
        loadingMore: false,
        error: errorMessage(error),
      }));
    }
  }, [client, prefix, state.nextMarker]);

  useEffect(() => {
    void load(false);
    return () => controllerRef.current?.abort();
  }, [prefix, client]);

  const refresh = useCallback(() => load(false, true), [load]);
  const updateFileMetadata = useCallback((key: string, size: number, lastModified: string) => {
    metadataPatchesRef.current.set(key, { size, last_modified: lastModified });
    setState((current) => ({
      ...current,
      files: current.files.map((file) => file.key === key
        ? { ...file, size, last_modified: lastModified }
        : file),
    }));
  }, []);
  const loadMore = useCallback(() => {
    if (state.truncated && state.nextMarker && !state.loadingMore) void load(true);
  }, [load, state.loadingMore, state.nextMarker, state.truncated]);

  return { ...state, refresh, updateFileMetadata, loadMore };
}
