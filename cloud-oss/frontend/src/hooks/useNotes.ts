import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { api, errorMessage, isAbort } from '../api/client';
import type { NoteEntry, NoteFolderEntry } from '../api/types';

export function useNotes(client: ApiClient = api) {
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [folders, setFolders] = useState<NoteFolderEntry[]>([]);
  const [prefix, setPrefix] = useState('');
  const [folder, setFolder] = useState('');
  const [requestedFolder, setRequestedFolder] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (targetFolder: string, preserveVisible = false) => {
    const requestId = ++requestIdRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    if (!preserveVisible) setLoading(true);
    setError(null);
    try {
      const result = await client.notes(targetFolder, controller.signal);
      if (requestId !== requestIdRef.current) return;
      setPrefix(result.prefix);
      setFolder(result.folder);
      setFolders(result.folders);
      setNotes(result.notes);
    } catch (loadError) {
      if (isAbort(loadError) || requestId !== requestIdRef.current) return;
      setError(errorMessage(loadError));
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        controllerRef.current = null;
      }
    }
  }, [client]);

  useEffect(() => {
    void load(requestedFolder);
    return () => controllerRef.current?.abort();
  }, [load, requestedFolder]);

  const refresh = useCallback(() => load(requestedFolder, true), [load, requestedFolder]);
  const navigate = useCallback((nextFolder: string) => {
    setSearchQuery('');
    setRequestedFolder(nextFolder);
  }, []);

  const filteredNotes = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return notes;
    return notes.filter((note) => `${note.name}\n${note.folder}`.toLocaleLowerCase().includes(query));
  }, [notes, searchQuery]);

  return {
    notes,
    folders,
    prefix,
    folder,
    loading,
    error,
    refresh,
    navigate,
    searchQuery,
    setSearchQuery,
    filteredNotes,
  };
}
