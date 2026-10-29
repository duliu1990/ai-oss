import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { errorMessage, isAbort } from '../api/client';
import type { UploadPart } from '../api/types';

export const CHUNK_SIZE = 5 * 1024 * 1024;
export const CHUNK_THRESHOLD = 5 * 1024 * 1024;
export const PART_RETRY_DELAYS = [1_000, 2_000, 4_000] as const;
const MULTIPART_CONCURRENCY = 3;

export type UploadStatus = 'queued' | 'uploading' | 'complete' | 'error' | 'cancelled';

export interface UploadTask {
  id: string;
  name: string;
  key: string;
  size: number;
  progress: number;
  status: UploadStatus;
  error: string | null;
  retrying: boolean;
}

interface UploadRuntime {
  file: File;
  key: string;
  uploadId: string | null;
  parts: Map<number, UploadPart>;
}

type ConfirmOverwrite = (name: string) => boolean | Promise<boolean>;

function taskId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function abortError(): Error {
  const error = new Error('Upload cancelled');
  error.name = 'AbortError';
  return error;
}

function retryDelay(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const finish = () => {
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(abortError());
    };
    const timer = globalThis.setTimeout(finish, delay);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export async function uploadPartWithRetry<T>(
  upload: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  for (let retry = 0; ; retry += 1) {
    if (signal.aborted) throw abortError();
    try {
      return await upload();
    } catch (error) {
      if (isAbort(error)) throw error;
      if (signal.aborted) throw abortError();
      const delay = PART_RETRY_DELAYS[retry];
      if (delay === undefined) throw error;
      await retryDelay(delay, signal);
    }
  }
}

function multipartProgress(runtime: UploadRuntime, totalParts: number): number {
  if (!runtime.uploadId) return 2;
  return Math.min(96, 4 + Math.round((runtime.parts.size / totalParts) * 90));
}

export function useUpload(client: ApiClient, onComplete: () => void) {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const controllers = useRef(new Map<string, AbortController>());
  const runtimes = useRef(new Map<string, UploadRuntime>());

  const update = useCallback((id: string, change: Partial<UploadTask>) => {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, ...change } : task));
  }, []);

  const execute = useCallback(async (id: string, retrying: boolean) => {
    const runtime = runtimes.current.get(id);
    if (!runtime || controllers.current.has(id)) return;

    const controller = new AbortController();
    controllers.current.set(id, controller);
    const multipart = runtime.file.size >= CHUNK_THRESHOLD;
    const totalParts = multipart ? Math.ceil(runtime.file.size / CHUNK_SIZE) : 0;
    update(id, {
      status: 'uploading',
      progress: multipart ? multipartProgress(runtime, totalParts) : 2,
      error: null,
      retrying,
    });

    try {
      if (!multipart) {
        update(id, { progress: 12 });
        await client.upload(runtime.file, runtime.key, controller.signal);
      } else {
        if (!runtime.uploadId) {
          runtime.parts.clear();
          const initialized = await client.initUpload(runtime.key, runtime.file.size, controller.signal);
          runtime.uploadId = initialized.upload_id;
          update(id, { progress: 4 });
        }

        const uploadId = runtime.uploadId;
        const pendingParts = Array.from({ length: totalParts }, (_, index) => index + 1)
          .filter((partNumber) => !runtime.parts.has(partNumber));
        let nextPartIndex = 0;
        const uploadNextParts = async () => {
          while (nextPartIndex < pendingParts.length) {
            if (controller.signal.aborted) throw abortError();
            const partNumber = pendingParts[nextPartIndex];
            nextPartIndex += 1;
            const startByte = (partNumber - 1) * CHUNK_SIZE;
            const chunk = runtime.file.slice(startByte, Math.min(startByte + CHUNK_SIZE, runtime.file.size));
            const uploaded = await uploadPartWithRetry(
              () => client.uploadPart(uploadId, partNumber, chunk, controller.signal),
              controller.signal,
            );
            runtime.parts.set(partNumber, { part_number: uploaded.part_number, etag: uploaded.etag });
            update(id, { progress: multipartProgress(runtime, totalParts) });
          }
        };

        const workerCount = Math.min(MULTIPART_CONCURRENCY, pendingParts.length);
        const results = await Promise.allSettled(
          Array.from({ length: workerCount }, () => uploadNextParts()),
        );
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason;
        }

        const parts = Array.from(runtime.parts.values())
          .sort((left, right) => left.part_number - right.part_number);
        if (parts.length !== totalParts) throw new Error('分片上传未完整完成，请重试。');
        await client.completeUpload(uploadId, parts, controller.signal);
      }

      update(id, { status: 'complete', progress: 100, retrying: false });
      runtimes.current.delete(id);
      onComplete();
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) {
        update(id, { status: 'cancelled', error: null, retrying: false });
      } else {
        update(id, { status: 'error', error: errorMessage(error), retrying: false });
      }
    } finally {
      if (controllers.current.get(id) === controller) controllers.current.delete(id);
    }
  }, [client, onComplete, update]);

  const start = useCallback((file: File, key: string) => {
    const id = taskId();
    runtimes.current.set(id, { file, key, uploadId: null, parts: new Map() });
    setTasks((current) => [{
      id,
      name: file.name,
      key,
      size: file.size,
      progress: 0,
      status: 'queued',
      error: null,
      retrying: false,
    }, ...current]);
    void execute(id, false);
  }, [execute]);

  const enqueue = useCallback(async (
    files: File[],
    prefix: string,
    existingNames: ReadonlySet<string>,
    confirmOverwrite: ConfirmOverwrite,
  ) => {
    for (const file of files) {
      if (existingNames.has(file.name) && !(await confirmOverwrite(file.name))) continue;
      start(file, `${prefix}${file.name}`);
    }
  }, [start]);

  const cancel = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    const runtime = runtimes.current.get(id);
    if (runtime?.uploadId) void client.cancelUpload(runtime.uploadId).catch(() => undefined);
    runtimes.current.delete(id);
    update(id, { status: 'cancelled', error: null, retrying: false });
  }, [client, update]);

  const retry = useCallback((id: string) => {
    const runtime = runtimes.current.get(id);
    if (runtime?.uploadId && runtime.parts.size === 0) {
      const abandonedUploadId = runtime.uploadId;
      runtime.uploadId = null;
      void client.cancelUpload(abandonedUploadId).catch(() => undefined);
    }
    void execute(id, true);
  }, [client, execute]);

  const discard = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    const runtime = runtimes.current.get(id);
    if (runtime?.uploadId) void client.cancelUpload(runtime.uploadId).catch(() => undefined);
    controllers.current.delete(id);
    runtimes.current.delete(id);
  }, [client]);

  const remove = useCallback((id: string) => {
    discard(id);
    setTasks((current) => current.filter((task) => task.id !== id));
  }, [discard]);

  const clearFinished = useCallback(() => {
    for (const task of tasks) {
      if (task.status !== 'queued' && task.status !== 'uploading') discard(task.id);
    }
    setTasks((current) => current.filter((task) => task.status === 'queued' || task.status === 'uploading'));
  }, [discard, tasks]);

  useEffect(() => () => {
    for (const controller of controllers.current.values()) controller.abort();
  }, []);

  return { tasks, enqueue, cancel, retry, remove, clearFinished };
}
