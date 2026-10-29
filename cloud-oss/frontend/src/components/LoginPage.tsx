import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../hooks/useAuth';
import { Icon } from './Icon';

interface LoginPageProps {
  onLogin: () => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      await login(username, password);
      onLogin();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-page">
      <div aria-hidden="true" className="login-grid" />
      <section aria-labelledby="login-title" className="login-card">
        <div className="login-brand">
          <span className="login-mark"><Icon name="archive" size={25} /></span>
          <span><strong>轻存储</strong><small>PRIVATE / 42</small></span>
        </div>
        <div className="login-heading">
          <span className="eyebrow">SECURE ACCESS</span>
          <h1 className="login-title" id="login-title">欢迎回来</h1>
          <p>登录以进入您的私人文件空间。</p>
        </div>
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>用户名</span>
            <input
              autoComplete="username"
              autoFocus
              className="login-input"
              disabled={loading}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="请输入用户名"
              required
              type="text"
              value={username}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              autoComplete="current-password"
              className="login-input"
              disabled={loading}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="请输入密码"
              required
              type="password"
              value={password}
            />
          </label>
          {error && <p aria-live="polite" className="login-error" role="alert">{error}</p>}
          <button className="login-btn" disabled={loading} type="submit">
            {loading && <span aria-hidden="true" className="login-spinner" />}
            {loading ? '正在登录…' : '登录'}
          </button>
        </form>
        <p className="login-footnote">PRIVATE STORAGE · ENCRYPTED TRANSIT</p>
      </section>
    </main>
  );
}
