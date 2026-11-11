import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage, isAbort } from './api/http';
import appLogo from '../assets/app-logo.png';

interface LoginPageProps {
  /** The server being signed in to; empty on the Web, where it is the current site. */
  base: string;
  /** Whether the server has login credentials configured; null while unknown. */
  authReady: boolean | null;
  onCheckAuth(): void;
  onLogin(username: string, password: string): Promise<void>;
  /** Present in the native apps, which choose their server at runtime. */
  onSettings?: () => void;
}

export function LoginPage({ base, authReady, onCheckAuth, onLogin, onSettings }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Ask the service whether it can authenticate anyone, so a 503 is not blamed on the password.
  useEffect(() => { onCheckAuth(); }, [onCheckAuth, base]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      // A success unmounts this page; the guards below cover that race.
      await onLogin(username, password);
    } catch (loginError) {
      if (mounted.current && !isAbort(loginError)) setError(errorMessage(loginError));
    } finally {
      if (mounted.current) setLoading(false);
    }
  };

  const unready = authReady === false;
  return (
    <main className="login-page" id="login">
      <div aria-hidden="true" className="login-grid" />
      <section aria-labelledby="login-title" className="login-card">
        <div className="login-brand">
          <span className="login-mark"><img src={appLogo} alt="" aria-hidden="true" /></span>
          <span><strong>轻云</strong><small>DRIVE · NOTES · MUSIC</small></span>
        </div>
        <div className="login-heading">
          <span className="eyebrow">SECURE ACCESS</span>
          <h1 className="login-title" id="login-title">欢迎回来</h1>
          <p>登录以进入您的私人文件、笔记和音乐空间。账号由服务维护者在服务端配置，这里没有注册入口。</p>
        </div>
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>用户名</span>
            <input
              autoCapitalize="none"
              autoComplete="username"
              autoCorrect="off"
              autoFocus
              className="login-input"
              disabled={loading || unready}
              id="login-username"
              maxLength={100}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="请输入用户名"
              required
              spellCheck={false}
              type="text"
              value={username}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              autoComplete="current-password"
              className="login-input"
              disabled={loading || unready}
              id="login-password"
              maxLength={200}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="请输入密码"
              required
              type="password"
              value={password}
            />
          </label>
          {unready && <p className="login-error" role="alert">该服务尚未配置登录凭据，暂时无法登录，请联系服务维护者。</p>}
          {error && <p aria-live="polite" className="login-error" role="alert">{error}</p>}
          <button className="login-btn" disabled={loading || unready} id="login-submit" type="submit">
            {loading && <span aria-hidden="true" className="spinner spinner--small" />}
            {loading ? '正在登录…' : '登录'}
          </button>
        </form>
        <p className="login-service">服务地址：{base || '当前站点'}</p>
        {onSettings && <button className="login-connection" disabled={loading} id="login-connection" onClick={onSettings} type="button">服务器设置</button>}
        <p className="login-footnote">PRIVATE STORAGE · ENCRYPTED TRANSIT</p>
      </section>
    </main>
  );
}
