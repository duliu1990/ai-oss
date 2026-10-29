import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../api/client';
import type { ApiClient } from '../api/client';
import type { FileWriteResponse } from '../api/types';

export const MAX_EDIT_BYTES = 1024 * 1024;
export type EditorStatus = 'loading' | 'dirty' | 'saved' | 'error';

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

interface UseEditorOptions {
  client: ApiClient;
  keyValue: string;
  onMissing: () => void;
  onSaved?: (result: FileWriteResponse) => void;
}

export function useEditor({ client, keyValue, onMissing, onSaved }: UseEditorOptions) {
  const [content, setContentState] = useState('');
  const [baseline, setBaseline] = useState('');
  const [status, setStatus] = useState<EditorStatus>('loading');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflictEtag, setConflictEtag] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const contentRef = useRef('');
  const baselineRef = useRef('');
  const etagRef = useRef('');
  const loadedRef = useRef(false);
  const mountedRef = useRef(true);
  const savingRef = useRef(false);
  const saveRequestRef = useRef(0);
  const missingRef = useRef(onMissing);
  const savedRef = useRef(onSaved);
  missingRef.current = onMissing;
  savedRef.current = onSaved;

  const showMissingRecovery = useCallback(() => {
    setMissing(true);
    setConflictEtag(null);
    setStatus('error');
    setMessage('文件已不存在。您的本地内容仍保留在编辑器中。');
  }, []);

  const load = useCallback(async (signal?: AbortSignal) => {
    setStatus('loading');
    setMessage(null);
    setConflictEtag(null);
    setMissing(false);
    try {
      const result = await client.editFile(keyValue, signal);
      if (signal?.aborted || !mountedRef.current) return;
      loadedRef.current = true;
      contentRef.current = result.content;
      baselineRef.current = result.content;
      etagRef.current = result.etag;
      setContentState(result.content);
      setBaseline(result.content);
      setStatus('saved');
    } catch (error) {
      if (signal?.aborted || !mountedRef.current) return;
      if (error instanceof ApiError && error.status === 404) {
        if (loadedRef.current) showMissingRecovery();
        else missingRef.current();
        return;
      }
      setStatus('error');
      setMessage(errorMessage(error));
    }
  }, [client, keyValue, showMissingRecovery]);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, [load]);

  const dirty = content !== baseline;

  useEffect(() => {
    if (!dirty) return undefined;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    globalThis.addEventListener('beforeunload', protect);
    return () => globalThis.removeEventListener('beforeunload', protect);
  }, [dirty]);

  const setContent = useCallback((value: string) => {
    contentRef.current = value;
    setContentState(value);
    setMessage(null);
    setConflictEtag(null);
    setStatus(value === baselineRef.current ? 'saved' : 'dirty');
  }, []);

  const save = useCallback(async (force = false): Promise<boolean> => {
    if (savingRef.current) return false;
    const snapshot = contentRef.current;
    const expectedEtag = etagRef.current;
    const size = utf8Bytes(snapshot);
    if (size > MAX_EDIT_BYTES) {
      setStatus('error');
      setMessage('内容超过 1 MiB 编辑上限，请缩减后重试。');
      return false;
    }

    savingRef.current = true;
    const requestId = ++saveRequestRef.current;
    setSaving(true);
    setMessage(null);
    try {
      const result = await client.updateFile({
        key: keyValue,
        content: snapshot,
        expected_etag: expectedEtag,
        ...(force ? { force: true } : {}),
      });
      if (!mountedRef.current || requestId !== saveRequestRef.current) return false;
      etagRef.current = result.etag;
      baselineRef.current = snapshot;
      setBaseline(snapshot);
      setConflictEtag(null);
      setMissing(false);
      setStatus(contentRef.current === snapshot ? 'saved' : 'dirty');
      savedRef.current?.(result);
      return true;
    } catch (error) {
      if (!mountedRef.current || requestId !== saveRequestRef.current) return false;
      if (error instanceof ApiError && error.status === 412) {
        const current = error.body?.current_etag;
        setConflictEtag(typeof current === 'string' ? current : 'unknown');
        setMessage('远端文件已发生变化，请选择重新加载或强制覆盖。');
      } else if (error instanceof ApiError && error.status === 404) {
        showMissingRecovery();
        return false;
      } else {
        setMessage(errorMessage(error));
      }
      setStatus('error');
      return false;
    } finally {
      savingRef.current = false;
      if (mountedRef.current && requestId === saveRequestRef.current) setSaving(false);
    }
  }, [client, keyValue, showMissingRecovery]);

  return {
    conflictEtag,
    content,
    dirty,
    message,
    missing,
    reload: load,
    save,
    saving,
    setContent,
    status,
  };
}
