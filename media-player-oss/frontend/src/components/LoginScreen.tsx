import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage, isAbort } from '../api/client';
import { browserStorage, platform, storedOrigin } from '../platform/connection';
import { useLibrary, useRuntime } from '../player/context';
import { ConnectionDialog } from './Dialogs';
import appLogo from '../assets/app-logo.png';

export function LoginScreen() {
  const { library, native } = useRuntime();
  const state = useLibrary();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Ask the service whether it can authenticate anyone, so a 503 is not blamed on the password.
  useEffect(() => { void library.checkAuthReady(); }, [library, state.base]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // A success unmounts this screen; the guards below cover that race.
      await library.login(username, password);
    } catch (failure) {
      if (mounted.current && !isAbort(failure)) setError(errorMessage(failure));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const unready = state.authReady === false;
  return <>
    <main className="login-shell" id="login">
      <form className="login-card" onSubmit={(event) => { void submit(event); }}>
        <div className="login-brand"><span className="brand-mark" aria-hidden="true"><img src={appLogo} alt="" width={43} height={43} /></span><span>轻听<small>OSS PLAYER</small></span></div>
        <h1 className="login-title">登录后收听你的私有曲库</h1>
        <p className="login-hint">账号由服务维护者在服务端配置，这里没有注册入口。</p>
        <label className="field">账号
          <input id="login-username" name="username" required maxLength={100} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={username} disabled={busy || unready} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="field">密码
          <input id="login-password" name="password" type="password" required maxLength={200} autoComplete="current-password" value={password} disabled={busy || unready} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {unready && <p className="notice error" role="alert">该服务尚未配置登录凭据，暂时无法登录，请联系服务维护者。</p>}
        {error && <p className="notice error" role="alert">{error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        <button id="login-submit" className="button button-dark login-submit" type="submit" disabled={busy || unready}>{busy ? '登录中…' : '登录'}</button>
        <p className="login-service">服务地址：{state.base || '当前站点'}</p>
        {native && <button id="login-connection" className="connection-link" type="button" disabled={busy} onClick={() => setSettings(true)}>连接设置</button>}
      </form>
    </main>
    {native && settings && <ConnectionDialog initialValue={state.base || storedOrigin(browserStorage()) || platform.preset} connected={state.base !== null} onClose={() => setSettings(false)} onMessage={setNotice} />}
  </>;
}
