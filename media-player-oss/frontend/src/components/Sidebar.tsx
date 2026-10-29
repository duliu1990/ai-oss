import type { LibraryView } from '../api/types';
import type { LibrarySnapshot } from '../library/store';
import { Icon } from './Icon';

interface Props {
  state: LibrarySnapshot;
  view: LibraryView;
  native: boolean;
  online: boolean;
  onView(view: LibraryView): void;
  onSettings(): void;
}

export function Sidebar({ state, view, native, online, onView, onSettings }: Props) {
  const config = state.config;
  const status = !online || state.error ? 'error' : config ? config.oss_ready ? '' : 'warn' : 'neutral';
  const label = !online ? '网络已断开' : state.error ? '服务不可用' : state.base === null ? '尚未连接服务'
    : config ? config.oss_ready ? 'OSS 已配置' : 'OSS 未配置' : '正在读取配置…';
  const detail = config ? config.oss_ready ? `${config.bucket} / ${config.prefix || '（根目录）'}`
    : `缺少：${config.oss_missing.join(', ')}` : '私有 OSS，经播放服务转发播放。';
  return <aside className="sidebar" aria-label="主导航">
    <div className="brand"><span className="brand-mark" aria-hidden="true"><Icon name="note" /></span><span>轻听<small>OSS PLAYER</small></span></div>
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
      <small>公开播放 · 曲目信息由服务端保存</small>
      {native && <button id="connection-settings" className="connection-link" type="button" onClick={onSettings}>连接设置</button>}
    </div>
  </aside>;
}
