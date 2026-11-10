import { useLayoutEffect, useRef } from 'react';
import appLogo from '../assets/app-logo.png';
import type { LibraryView } from '../api/types';
import type { LibrarySnapshot } from '../library/store';
import { Icon } from './Icon';

interface Props {
  state: LibrarySnapshot;
  view: LibraryView;
  native: boolean;
  online: boolean;
  mobile: boolean;
  open: boolean;
  onClose(): void;
  onView(view: LibraryView): void;
  onSettings(): void;
  onLogout(): void;
}

export function Sidebar({ state, view, native, online, mobile, open, onClose, onView, onSettings, onLogout }: Props) {
  const ref = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      opener.current?.focus();
      opener.current = null;
      return;
    }
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLButtonElement>('.menu-close')?.focus();
    return () => { document.body.style.overflow = overflow; };
  }, [open]);

  const config = state.config;
  const status = !online || state.error ? 'error' : config ? config.oss_ready ? '' : 'warn' : 'neutral';
  const label = !online ? '网络已断开' : state.error ? '服务不可用' : state.base === null ? '尚未连接服务'
    : config ? config.oss_ready ? 'OSS 已配置' : 'OSS 未配置' : '正在读取配置…';
  const detail = config ? config.oss_ready ? `${config.bucket} / ${config.prefix || '（根目录）'}`
    : `缺少：${config.oss_missing.join(', ')}` : '私有 OSS，经播放服务转发播放。';
  return <aside id="sidebar" className="sidebar" ref={ref} hidden={mobile && !open} role={mobile ? 'dialog' : undefined} aria-modal={open ? true : undefined} aria-label="主导航" onKeyDown={(event) => {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <div className="sidebar-heading">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><img src={appLogo} alt="" width={43} height={43} /></span><span>轻听<small>OSS PLAYER</small></span></div>
      <button className="icon-button menu-close" type="button" aria-label="关闭菜单" onClick={onClose}><Icon name="close" /></button>
    </div>
    <div className="nav-caption">我的音乐</div>
    <nav className="navigation">
      <button className={`nav-link ${view === 'all' ? 'is-active' : ''}`} type="button" data-view="all" aria-pressed={view === 'all'} onClick={() => onView('all')}>
        <Icon name="note" />全部音乐<span id="count-all" className="nav-count">{state.tracks.length}</span>
      </button>
      <button className={`nav-link ${view === 'favorites' ? 'is-active' : ''}`} type="button" data-view="favorites" aria-pressed={view === 'favorites'} onClick={() => onView('favorites')}>
        <Icon name="heart" />我喜欢<span id="count-favorites" className="nav-count">{state.tracks.filter((track) => track.favorite).length}</span>
      </button>
    </nav>
    <div className="sidebar-bottom">
      <div className="local-badge" role="status"><span id="oss-dot" className={`status-dot ${status}`} /><span id="oss-label">{label}</span></div>
      <p id="oss-detail">{detail}</p>
      <small>登录后收听 · 曲目信息由服务端保存</small>
      <button id="logout" className="connection-link" type="button" onClick={onLogout}>退出登录</button>
      {native && <button id="connection-settings" className="connection-link" type="button" onClick={onSettings}>连接设置</button>}
    </div>
  </aside>;
}
