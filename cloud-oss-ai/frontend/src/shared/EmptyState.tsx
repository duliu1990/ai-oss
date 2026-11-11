import type { ReactNode } from 'react';
import { Icon } from './Icon';
import type { IconName } from './Icon';

interface EmptyStateProps {
  icon?: IconName;
  eyebrow?: string;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  id?: string;
}

export function EmptyState({ icon, eyebrow, title, children, className, id }: EmptyStateProps) {
  return (
    <div className={`empty-state${className ? ` ${className}` : ''}`} id={id}>
      {icon && <div className="empty-orbit" aria-hidden="true"><Icon name={icon} size={38} /></div>}
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      {title && <h2>{title}</h2>}
      {children && <p>{children}</p>}
    </div>
  );
}
