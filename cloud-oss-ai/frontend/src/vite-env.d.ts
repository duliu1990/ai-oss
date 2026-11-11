/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Default server for a fresh native install; ignored by the Web build. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
