import { useState, useCallback, useEffect } from 'react';
import type { LoginRequest, LoginResponse } from '../api/types';

const TOKEN_KEY = 'cloud_oss_token';
const AUTH_CHANGE_EVENT = 'cloud-oss-auth-change';

/** Parse the JWT payload and check whether it has expired. */
function isTokenValid(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    return token ? isTokenValid(token) : false;
  });

  useEffect(() => {
    const syncAuthState = () => {
      const token = localStorage.getItem(TOKEN_KEY);
      if (token && isTokenValid(token)) {
        setIsAuthenticated(true);
        return;
      }
      if (token) localStorage.removeItem(TOKEN_KEY);
      setIsAuthenticated(false);
    };

    syncAuthState();
    globalThis.addEventListener(AUTH_CHANGE_EVENT, syncAuthState);
    return () => globalThis.removeEventListener(AUTH_CHANGE_EVENT, syncAuthState);
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<void> => {
    const request: LoginRequest = { username, password };
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      credentials: 'omit',
    });
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => ({}));
      const detail = typeof data === 'object'
        && data !== null
        && 'detail' in data
        && typeof data.detail === 'string'
        ? data.detail
        : '登录失败';
      throw new Error(detail);
    }
    const data = await res.json() as LoginResponse;
    localStorage.setItem(TOKEN_KEY, data.token);
    setIsAuthenticated(true);
    globalThis.dispatchEvent(new Event(AUTH_CHANGE_EVENT));
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    setIsAuthenticated(false);
    globalThis.dispatchEvent(new Event(AUTH_CHANGE_EVENT));
  }, []);

  return { isAuthenticated, login, logout };
}

/** Return the current token for authenticated API requests. */
export function getAuthToken(): string | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token && isTokenValid(token)) return token;
  return null;
}

/** Clear the current token after an unauthorized response. */
export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
