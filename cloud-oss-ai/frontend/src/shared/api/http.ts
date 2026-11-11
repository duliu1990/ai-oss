const REQUEST_TIMEOUT = 20_000;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** How a client obtains the current token and reports one that the server rejected. */
export interface AuthPort {
  token(): string | null;
  onUnauthorized(): void;
}

export const anonymousAuth: AuthPort = { token: () => null, onUnauthorized: () => {} };

export interface LoginInput { username: string; password: string }
export interface LoginResult { token: string; expires_in: number }
export interface AuthStatus { auth_required: boolean; auth_ready: boolean }

export function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  if (isAbort(error)) return '操作已取消。';
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

export function endpoint(base: string, path: string, params?: Record<string, string>): string {
  const query = params ? `?${new URLSearchParams(params).toString()}` : '';
  return `${base}${path}${query}`;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function invalidResponse(): never {
  throw new ApiError('服务返回了无法识别的数据，请检查连接地址。');
}

/** Links the caller's signal to a timeout so either one aborts the request. */
export function withAbort(timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

export interface RequestOptions {
  /** Login and readiness probes must not send, nor drop, the stored token. */
  anonymous?: boolean;
  timeoutMs?: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * The transport every module shares: one base URL, one token source, the write marker the
 * server's local guard requires, and a 401 that drops the session instead of reloading the page.
 */
export class HttpClient {
  constructor(
    readonly base: string,
    // Native browser fetch rejects a class receiver; call it on its global owner.
    protected readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    protected readonly auth: AuthPort = anonymousAuth,
  ) {}

  /** Media elements and download links cannot send headers, so they carry the token in the query. */
  protected authorizedUrl(path: string, params: Record<string, string>): string {
    const token = this.auth.token();
    return endpoint(this.base, path, token ? { ...params, token } : params);
  }

  protected headers(init: RequestInit, anonymous = false): HeadersInit | undefined {
    const method = (init.method ?? 'GET').toUpperCase();
    const token = anonymous ? null : this.auth.token();
    if (SAFE_METHODS.has(method) && !token) return init.headers;
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    // local_guard rejects any write without this marker, login included.
    if (!SAFE_METHODS.has(method)) headers['X-App-Client'] = 'web';
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  protected async request(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
    { anonymous = false, timeoutMs = REQUEST_TIMEOUT }: RequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const abort = withAbort(timeoutMs, signal);
    try {
      const response = await this.fetcher(endpoint(this.base, path), {
        ...init,
        headers: this.headers(init, anonymous),
        signal: abort.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        // A rejected session must drop the stored token; a rejected password must not.
        if (response.status === 401 && !anonymous) this.auth.onUnauthorized();
        const detail = isRecord(data) && typeof data.detail === 'string'
          ? data.detail
          : `请求失败（${response.status}）`;
        throw new ApiError(detail, response.status, isRecord(data) ? data : null);
      }
      if (!isRecord(data)) invalidResponse();
      return data;
    } catch (error) {
      if (abort.timedOut()) throw new ApiError('连接超时，请检查网络后重试。');
      if (isAbort(error) || error instanceof ApiError) throw error;
      throw new ApiError(this.unreachableMessage);
    } finally {
      abort.dispose();
    }
  }

  protected get unreachableMessage(): string {
    return '无法连接服务，请检查网络和服务地址。';
  }

  async authStatus(signal?: AbortSignal): Promise<AuthStatus> {
    const value = await this.request('/api/auth/status', {}, signal, { anonymous: true });
    if (typeof value.auth_required !== 'boolean' || typeof value.auth_ready !== 'boolean') invalidResponse();
    return value as unknown as AuthStatus;
  }

  async login(input: LoginInput, signal?: AbortSignal): Promise<LoginResult> {
    const value = await this.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }, signal, { anonymous: true });
    if (typeof value.token !== 'string' || !value.token || typeof value.expires_in !== 'number') invalidResponse();
    return value as unknown as LoginResult;
  }
}
