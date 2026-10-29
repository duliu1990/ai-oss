import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, errorMessage } from '../api/client';
import type { ApiClient } from '../api/client';

interface UseMdxEditorOptions {
  key: string;
  client?: ApiClient;
  enabled?: boolean;
  storage?: 'files' | 'notes';
}

export interface UseMdxEditorReturn {
  loading: boolean;
  error: string | null;
  initialMarkdown: string;
  baselineMarkdown: string;
  saving: boolean;
  dirty: boolean;
  save: (currentMarkdown: string) => Promise<void>;
  conflict: boolean;
  conflictEtag: string | null;
  reloadFromServer: () => Promise<string | null>;
  forceSave: (currentMarkdown: string) => Promise<void>;
  dismissConflict: () => void;
  missing: boolean;
  setCurrentMarkdown: (markdown: string) => void;
}

export function useMdxEditor({ key, client = api, enabled = true, storage = 'files' }: UseMdxEditorOptions): UseMdxEditorReturn {
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [initialMarkdown, setInitialMarkdown] = useState('');
  const [baselineMarkdown, setBaselineMarkdown] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [conflictEtag, setConflictEtag] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const baselineRef = useRef('');
  const currentRef = useRef('');
  const etagRef = useRef('');
  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  const loadControllerRef = useRef<AbortController | null>(null);

  const applyLoadedFile = useCallback((content: string, etag: string) => {
    baselineRef.current = content;
    currentRef.current = content;
    etagRef.current = etag;
    setInitialMarkdown(content);
    setBaselineMarkdown(content);
    setDirty(false);
    setConflictEtag(null);
    setMissing(false);
    setError(null);
  }, []);

  const load = useCallback(async (): Promise<string | null> => {
    if (!enabled) {
      setLoading(false);
      return null;
    }
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const result = storage === 'notes'
        ? await client.readNote(key, controller.signal)
        : await client.editFile(key, controller.signal);
      if (controller.signal.aborted || !mountedRef.current) return null;
      applyLoadedFile(result.content, result.etag);
      return result.content;
    } catch (loadError) {
      if (controller.signal.aborted || !mountedRef.current) return null;
      setError(errorMessage(loadError));
      return null;
    } finally {
      if (mountedRef.current && loadControllerRef.current === controller) {
        setLoading(false);
        loadControllerRef.current = null;
      }
    }
  }, [applyLoadedFile, client, enabled, key, storage]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      loadControllerRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!dirty) return undefined;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    globalThis.addEventListener('beforeunload', protect);
    return () => globalThis.removeEventListener('beforeunload', protect);
  }, [dirty]);

  const setCurrentMarkdown = useCallback((markdown: string) => {
    currentRef.current = markdown;
    setDirty(markdown !== baselineRef.current);
    setError(null);
  }, []);

  const persist = useCallback(async (markdown: string, force: boolean): Promise<void> => {
    if (savingRef.current || missing) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const request = {
        key,
        content: markdown,
        expected_etag: etagRef.current,
        ...(force ? { force: true } : {}),
      };
      const result = storage === 'notes'
        ? await client.updateNote(request)
        : await client.updateFile(request);
      if (!mountedRef.current) return;
      baselineRef.current = markdown;
      etagRef.current = result.etag;
      setBaselineMarkdown(markdown);
      setDirty(currentRef.current !== markdown);
      setConflictEtag(null);
      setMissing(false);
    } catch (saveError) {
      if (!mountedRef.current) return;
      if (saveError instanceof ApiError && saveError.status === 412) {
        const currentEtag = saveError.body?.current_etag;
        setConflictEtag(typeof currentEtag === 'string' ? currentEtag : 'unknown');
        setError('远端文件已发生变化，请选择重新加载或强制覆盖。');
      } else if (saveError instanceof ApiError && saveError.status === 404) {
        setMissing(true);
        setConflictEtag(null);
        setError('文件已被删除，您的本地内容仍保留在编辑器中。');
      } else {
        setError(errorMessage(saveError));
      }
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  }, [client, key, missing, storage]);

  const save = useCallback((markdown: string) => persist(markdown, false), [persist]);
  const forceSave = useCallback((markdown: string) => persist(markdown, true), [persist]);
  const dismissConflict = useCallback(() => {
    setConflictEtag(null);
    setError(null);
  }, []);

  return {
    loading,
    error,
    initialMarkdown,
    baselineMarkdown,
    saving,
    dirty,
    save,
    conflict: conflictEtag !== null,
    conflictEtag,
    reloadFromServer: load,
    forceSave,
    dismissConflict,
    missing,
    setCurrentMarkdown,
  };
}
