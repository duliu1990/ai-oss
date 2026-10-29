import type { FileEntry } from '../api/types';
import { Icon } from './Icon';

interface SearchBarProps {
  query: string;
  results: FileEntry[];
  searching: boolean;
  onChange: (query: string) => void;
  onSelect: (file: FileEntry) => void;
}

export function SearchBar({ query, results, searching, onChange, onSelect }: SearchBarProps) {
  const open = query.trim().length > 0;
  return (
    <div className="search-wrap">
      <label className="search-bar">
        <Icon name="search" size={18} />
        <span className="sr-only">搜索文件</span>
        <input
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
          placeholder="搜索当前目录…"
          spellCheck={false}
          type="search"
          value={query}
        />
        {searching && <span aria-label="正在搜索" className="search-spinner" />}
        {query && !searching && (
          <button aria-label="清除搜索" className="icon-button compact" onClick={() => onChange('')} type="button">
            <Icon name="close" size={15} />
          </button>
        )}
      </label>
      {open && (
        <div className="search-results" role="listbox">
          <div className="search-results-label">{searching ? '正在检索…' : `${results.length} 项匹配`}</div>
          {!searching && results.length === 0 && <div className="search-empty">没有找到相关文件</div>}
          {results.slice(0, 12).map((result) => (
            <button
              className="search-result"
              key={result.key}
              onClick={() => onSelect(result)}
              role="option"
              type="button"
            >
              <Icon name={result.is_dir ? 'folder' : 'file'} size={18} />
              <span><strong>{result.name}</strong><small>{result.key}</small></span>
              <Icon name="chevron" size={15} />
            </button>
          ))}
          {results.length > 12 && <div className="search-more">另有 {results.length - 12} 项结果</div>}
        </div>
      )}
    </div>
  );
}
