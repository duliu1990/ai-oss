import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ConfigResponse } from '../api/types';
import { Icon } from './Icon';

export type ActiveSection = 'files' | 'notes';

interface LayoutProps {
  activeSection?: ActiveSection;
  backgroundInert?: boolean;
  config: ConfigResponse | null;
  children: ReactNode;
  header: ReactNode;
  onGoRoot: () => void;
  onLogout: () => void;
  onSwitchSection?: (section: ActiveSection) => void;
  onUpload: () => void;
}

export function Layout({ activeSection = 'files', backgroundInert = false, config, children, header, onGoRoot, onLogout, onSwitchSection, onUpload }: LayoutProps) {
  const [navOpen, setNavOpen] = useState(false);
  const closeNav = () => setNavOpen(false);
  return (
    <div aria-hidden={backgroundInert ? true : undefined} className={`app-shell${activeSection === 'notes' ? ' notes-active' : ''}`} inert={backgroundInert ? true : undefined}>
      {navOpen && <button aria-label="关闭导航" className="nav-scrim" onClick={closeNav} type="button" />}
      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Icon name="archive" size={24} /></div>
          <div><strong>轻存储</strong><small>PRIVATE / 42</small></div>
        </div>
        <button className="primary-action" onClick={() => { onUpload(); closeNav(); }} type="button">
          <Icon name="upload" size={18} />
          上传文件
          <span>U</span>
        </button>
        <nav className="side-nav" aria-label="主导航">
          <button className={activeSection === 'files' ? 'active' : ''} onClick={() => { if (onSwitchSection) onSwitchSection('files'); onGoRoot(); closeNav(); }} type="button">
            <Icon name="archive" size={19} /><span>轻盘</span><small>01</small>
          </button>
          <button className={activeSection === 'notes' ? 'active' : ''} onClick={() => { if (onSwitchSection) onSwitchSection('notes'); closeNav(); }} type="button">
            <Icon name="note" size={19} /><span>轻笔记</span><small>02</small>
          </button>
        </nav>
        <div className="sidebar-note">
          <span className="eyebrow">ACTIVE STORAGE</span>
          <strong>{config?.bucket || '连接中…'}</strong>
          <p>{config ? `/${config.prefix}` : '正在读取服务配置'}</p>
          <div className={`status-line ${config ? 'online' : ''}`}>
            <span />{config ? `PORT ${config.port}` : 'DISCOVERING'}
          </div>
        </div>
        <button className="logout-btn" onClick={() => { closeNav(); onLogout(); }} type="button">退出登录</button>
        <p className="privacy-note">私有空间 · 不公开索引<br />传输仅经过您的服务</p>
      </aside>
      <section className="content-shell">
        <header className="topbar">
          <button aria-label="打开导航" className="mobile-menu" onClick={() => setNavOpen(true)} type="button">
            <Icon name="menu" />
          </button>
          {header}
        </header>
        <main className="main-content">{children}</main>
      </section>
    </div>
  );
}
