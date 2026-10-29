import type { ReactNode } from 'react';

export type IconName = 'play' | 'pause' | 'prev' | 'next' | 'shuffle' | 'repeat' | 'volume' | 'muted' | 'heart' | 'heart-fill' | 'edit' | 'note' | 'search' | 'refresh';
const paths: Record<IconName, ReactNode> = {
  play: <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" stroke="none" />,
  pause: <g fill="currentColor" stroke="none"><rect x="6.5" y="5" width="4" height="14" rx="1.2" /><rect x="13.5" y="5" width="4" height="14" rx="1.2" /></g>,
  prev: <path d="M18 6.2v11.6a.8.8 0 0 1-1.25.66L9 13V17a1 1 0 0 1-2 0V7a1 1 0 0 1 2 0v4l7.75-5.46A.8.8 0 0 1 18 6.2z" fill="currentColor" stroke="none" />,
  next: <path d="M6 6.2v11.6a.8.8 0 0 0 1.25.66L15 13V17a1 1 0 0 0 2 0V7a1 1 0 0 0-2 0v4L7.25 5.54A.8.8 0 0 0 6 6.2z" fill="currentColor" stroke="none" />,
  shuffle: <path d="M16 4h4v4M4 20 20 4M20 16v4h-4M15 15l5 5M4 4l5 5" />,
  repeat: <path d="m17 2 4 4-4 4M3 12v-2a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 12v2a4 4 0 0 1-4 4H3" />,
  volume: <><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" stroke="none" /><path d="M15.5 9a4 4 0 0 1 0 6m2.5-8.5a7.5 7.5 0 0 1 0 11" /></>,
  muted: <><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" stroke="none" /><path d="m16 9.5 5 5m0-5-5 5" /></>,
  heart: <path d="M12 19.5s-7-4.3-7-9.6A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6z" />,
  'heart-fill': <path d="M12 19.5s-7-4.3-7-9.6A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6z" fill="currentColor" />,
  edit: <path d="m14.5 6.5 3 3M5 19l1-4 9.8-9.8a1.6 1.6 0 0 1 2.2 0l.8.8a1.6 1.6 0 0 1 0 2.2L9 18l-4 1z" />,
  note: <path d="M9 18V6.5l10-2V16M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm10-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM9 10l10-2" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></>,
  refresh: <path d="M19 12a7 7 0 1 1-2.05-4.95M19 4.5V8h-3.5" />,
};

export function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
