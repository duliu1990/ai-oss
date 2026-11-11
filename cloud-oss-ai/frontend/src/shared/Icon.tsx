import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'archive' | 'arrow-down' | 'audio' | 'check' | 'chevron' | 'chevron-down' | 'close' | 'download' | 'edit'
  | 'file' | 'folder' | 'fullscreen' | 'fullscreen-exit' | 'grid' | 'image' | 'list' | 'menu' | 'more' | 'move'
  | 'note' | 'pdf' | 'plus' | 'refresh' | 'rename' | 'search' | 'sheet' | 'slides' | 'text' | 'trash' | 'upload' | 'video' | 'word'
  | 'play' | 'pause' | 'prev' | 'next' | 'shuffle' | 'repeat' | 'volume' | 'muted' | 'heart' | 'heart-fill' | 'music'
  | 'logout' | 'server';

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

const paths: Record<IconName, ReactNode> = {
  archive: <><path d="M4 7h16v13H4z"/><path d="M3 3h18v4H3zM9 11h6"/></>,
  'arrow-down': <path d="M12 4v15m-6-6 6 6 6-6"/>,
  audio: <><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  chevron: <path d="m9 18 6-6-6-6"/>,
  'chevron-down': <path d="m6 9 6 6 6-6"/>,
  close: <path d="M6 6l12 12M18 6 6 18"/>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M5 20h14"/></>,
  edit: <><path d="M4 20h4l11-11-4-4L4 16z"/><path d="m13 7 4 4M4 20l4-1-3-3z"/></>,
  file: <><path d="M6 2h8l5 5v15H6z"/><path d="M14 2v6h5"/></>,
  folder: <path d="M3 6h7l2 2h9v12H3z"/>,
  fullscreen: <path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5"/>,
  'fullscreen-exit': <path d="M3 8h5V3m13 5h-5V3M3 16h5v5m13-5h-5v5"/>,
  grid: <><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="1"/><circle cx="9" cy="9" r="2"/><path d="m4 18 5-5 4 4 3-3 5 5"/></>,
  list: <><path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  move: <><path d="M4 7h6l2 2h8v10H4z"/><path d="m14 4 3 3-3 3"/></>,
  note: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/></>,
  pdf: <><path d="M6 2h8l5 5v15H6z"/><path d="M14 2v6h5M9 17v-5h2a1.5 1.5 0 0 1 0 3H9m6 2v-5h3"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  refresh: <><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/></>,
  rename: <><path d="M4 20h5M6.5 20V5M4 5h5"/><path d="m13 16 7-7-3-3-7 7v3z"/></>,
  search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,
  sheet: <><path d="M5 2h10l4 4v16H5z"/><path d="M15 2v5h4M8 11h8M8 15h8M8 19h8M11 9v12"/></>,
  slides: <><path d="M5 2h10l4 4v16H5z"/><path d="M15 2v5h4"/><rect x="8" y="11" width="8" height="6"/><path d="m10 15 2-2 2 2"/></>,
  text: <><path d="M6 2h8l5 5v15H6z"/><path d="M14 2v6h5M9 13h6M9 17h6"/></>,
  trash: <><path d="M4 7h16M9 3h6l1 4H8zM6 7l1 14h10l1-14M10 11v6M14 11v6"/></>,
  upload: <><path d="M12 16V4m-5 5 5-5 5 5"/><path d="M5 20h14"/></>,
  video: <><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2z"/></>,
  word: <><path d="M5 2h10l4 4v16H5z"/><path d="M15 2v5h4M8 11l1.4 7 2.6-5 2.6 5L16 11"/></>,
  // Player controls keep their filled glyphs.
  play: <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" stroke="none"/>,
  pause: <g fill="currentColor" stroke="none"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></g>,
  prev: <path d="M18 6.2v11.6a.8.8 0 0 1-1.25.66L9 13V17a1 1 0 0 1-2 0V7a1 1 0 0 1 2 0v4l7.75-5.46A.8.8 0 0 1 18 6.2z" fill="currentColor" stroke="none"/>,
  next: <path d="M6 6.2v11.6a.8.8 0 0 0 1.25.66L15 13V17a1 1 0 0 0 2 0V7a1 1 0 0 0-2 0v4L7.25 5.54A.8.8 0 0 0 6 6.2z" fill="currentColor" stroke="none"/>,
  shuffle: <path d="M16 4h4v4M4 20 20 4M20 16v4h-4M15 15l5 5M4 4l5 5"/>,
  repeat: <path d="m17 2 4 4-4 4M3 12v-2a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 12v2a4 4 0 0 1-4 4H3"/>,
  volume: <><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" stroke="none"/><path d="M15.5 9a4 4 0 0 1 0 6m2.5-8.5a7.5 7.5 0 0 1 0 11"/></>,
  muted: <><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" fill="currentColor" stroke="none"/><path d="m16 9.5 5 5m0-5-5 5"/></>,
  heart: <path d="M12 19.5s-7-4.3-7-9.6A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6z"/>,
  'heart-fill': <path d="M12 19.5s-7-4.3-7-9.6A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6z" fill="currentColor"/>,
  music: <path d="M9 18V6.5l10-2V16M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm10-2a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM9 10l10-2"/>,
  logout: <><path d="M14 4h5v16h-5"/><path d="M10 8l-4 4 4 4M6 12h10"/></>,
  server: <><rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M8 7h.01M8 17h.01"/></>,
};

export function Icon({ name, size = 20, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
