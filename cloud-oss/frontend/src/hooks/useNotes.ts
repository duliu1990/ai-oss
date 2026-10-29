import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { api, errorMessage, isAbort } from '../api/client';
import type { NoteEntry } from '../api/types';

export function useNotes(client: ApiClient = api) {
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const [prefix, setPrefix] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async (preserveVisible = false) => {
    const requestId = ++requestIdRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    if (!preserveVisible) setLoading(true);
    setError(null);
    try {
      const result = await client.notes(controller.signal);
      if (requestId !== requestIdRef.current) return;
      setPrefix(result.prefix);
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
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);
  const filteredNotes = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return notes;
    return notes.filter((note) => `${note.name}\n${note.folder}`.toLocaleLowerCase().includes(query));
  }, [notes, searchQuery]);

  return {
    notes,
    prefix,
    loading,
    error,
    refresh,
    searchQuery,
    setSearchQuery,
    filteredNotes,
  };
}
