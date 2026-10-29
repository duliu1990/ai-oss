import { Icon } from './Icon';

export interface BreadcrumbSegment {
  label: string;
  prefix: string;
}

export function breadcrumbSegments(prefix: string): BreadcrumbSegment[] {
  const names = prefix.split('/').filter(Boolean);
  return [
    { label: '根目录', prefix: '' },
    ...names.map((label, index) => ({
      label,
      prefix: `${names.slice(0, index + 1).join('/')}/`,
    })),
  ];
}

interface BreadcrumbProps {
  prefix: string;
  onNavigate: (prefix: string) => void;
}

export function Breadcrumb({ prefix, onNavigate }: BreadcrumbProps) {
  const segments = breadcrumbSegments(prefix);
  return (
    <nav aria-label="文件路径" className="breadcrumb">
      {segments.map((segment, index) => {
        const current = index === segments.length - 1;
        return (
          <span className="breadcrumb-segment" key={segment.prefix || 'root'}>
            {index > 0 && <Icon name="chevron" size={14} />}
            <button
              aria-current={current ? 'page' : undefined}
              className={current ? 'current' : ''}
              disabled={current}
              onClick={() => onNavigate(segment.prefix)}
              type="button"
            >
              {segment.label}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
