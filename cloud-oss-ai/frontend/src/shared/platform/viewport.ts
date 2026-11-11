import { Capacitor } from '@capacitor/core';

/** iPhone and iPad, including iPadOS reporting itself as a Mac. */
export function isAppleTouch(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator): boolean {
  return /iPad|iPhone|iPod/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
}

/**
 * iOS zooms the page into any focused field under 16px and never zooms back out, which leaves the
 * whole mobile layout enlarged after closing the editor. Pinning the scale stops that focus zoom;
 * Safari still honours pinch-zoom, and the native app is not meant to be zoomed like a page.
 */
export function lockFocusZoom(doc: Document = document, native = Capacitor.isNativePlatform(), appleTouch = isAppleTouch()): void {
  if (!native && !appleTouch) return;
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const parts = meta.content.split(',').map((part) => part.trim()).filter((part) => part && !/^maximum-scale\s*=/.test(part));
  meta.content = [...parts, 'maximum-scale=1'].join(', ');
}
