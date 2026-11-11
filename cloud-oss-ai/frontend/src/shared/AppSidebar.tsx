import { useLayoutEffect, useRef } from 'react';
import appLogo from '../assets/app-logo.png';
import { Icon } from './Icon';
import type { IconName } from './Icon';

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  href: string;
  count?: number;
}

export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

export interface SidebarStatus {
  tone: '' | 'error' | 'warn' | 'neutral';
  label: string;
  detail: string;
}

interface AppSidebarProps {
  groups: readonly NavGroup[];
  active: string;
  status: SidebarStatus;
  /** On narrow screens the sidebar is a modal drawer, hidden until opened. */
  mobile: boolean;
  open: boolean;
  onClose(): void;
  onLogout(): void;
  /** Present in the native apps, which choose their server at runtime. */
  onSettings?: () => void;
  inert?: boolean;
}

export function AppSidebar({ groups, active, status, mobile, open, onClose, onLogout, onSettings, inert }: AppSidebarProps) {
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

  return <aside id="sidebar" className="sidebar" ref={ref} hidden={mobile && !open} inert={inert} role={mobile ? 'dialog' : undefined} aria-modal={open ? true : undefined} aria-label="主导航" onKeyDown={(event) => {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') {
      const targets = [...event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)')];
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <div className="sidebar-heading">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><img src={appLogo} alt="" width={43} height={43} /></span><span>轻云<small>PRIVATE CLOUD</small></span></div>
      <button className="icon-button menu-close" type="button" aria-label="关闭菜单" onClick={onClose}><Icon name="close" /></button>
    </div>
    {groups.map((group) => <div className="nav-group" key={group.label}>
      <div className="nav-caption">{group.label}</div>
      <nav className="navigation" aria-label={group.label}>
        {group.items.map((item) => <a key={item.id} className={`nav-link ${active === item.id ? 'is-active' : ''}`} href={item.href} data-view={item.id} aria-current={active === item.id ? 'page' : undefined} onClick={onClose}>
          <Icon name={item.icon} />{item.label}{item.count !== undefined && <span id={`count-${item.id}`} className="nav-count">{item.count}</span>}
        </a>)}
      </nav>
    </div>)}
    <div className="sidebar-bottom">
      <div className="local-badge" role="status"><span id="oss-dot" className={`status-dot ${status.tone}`} /><span id="oss-label">{status.label}</span></div>
      <p id="oss-detail">{status.detail}</p>
      <small>私有空间 · 不公开索引 · 传输仅经过您的服务</small>
      {onSettings && <button id="connection-settings" className="connection-link" type="button" onClick={onSettings}><Icon name="server" size={16} />连接设置</button>}
      <button id="logout" className="connection-link" type="button" onClick={onLogout}><Icon name="logout" size={16} />退出登录</button>
    </div>
  </aside>;
}
