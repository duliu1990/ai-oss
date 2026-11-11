import { useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage } from './api/http';
import { Dialog } from './Dialog';

interface ConnectionDialogProps {
  initialValue: string;
  /** False until a first server is chosen; the dialog cannot be dismissed before that. */
  connected: boolean;
  /** Validates and switches to the server; returns whether the address was persisted. */
  onConnect(value: string): boolean;
  onClose(): void;
  onMessage(message: string): void;
}

/** Native apps choose their server at runtime; the Web build always uses the current site. */
export function ConnectionDialog({ initialValue, connected, onConnect, onClose, onMessage }: ConnectionDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      const persisted = onConnect(value);
      onMessage(persisted ? '连接地址已保存。' : '正在连接；本机存储不可用，下次需重新输入地址。');
      onClose();
    } catch (failure) { setError(errorMessage(failure)); }
  };
  return <Dialog open id="connection-dialog" titleId="connection-title" className="form-dialog" eyebrow="SERVER" title="连接服务" dismissible={connected} onClose={onClose} onSubmit={submit}>
    <p className="dialog-hint">支持 HTTP 和 HTTPS，仅含域名或 IP 和可选端口；不写协议时按 http:// 连接。连接后需用该服务的账号登录，无需 OSS 凭据。</p>
    {/* type="text" so a bare host:port is not rejected by the browser's URL check before it reaches validateOrigin. */}
    <label className="field connection-field">服务地址<input id="server-origin" type="text" inputMode="url" required value={value} maxLength={2048} placeholder="http://127.0.0.1:8790" autoCapitalize="none" autoCorrect="off" autoComplete="url" spellCheck={false} onChange={(event) => setValue(event.target.value)} /></label>
    <p className="dialog-hint">切换服务会停止播放并清除旧曲库、队列和播放进度；每个服务的登录状态单独保存。当前仅支持前台在线播放，不提供后台、锁屏或离线播放。</p>
    {error && <p className="field-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      {connected && <button type="button" onClick={onClose}>取消</button>}
      <button className="solid-button" type="submit">保存并连接</button>
    </div>
  </Dialog>;
}
