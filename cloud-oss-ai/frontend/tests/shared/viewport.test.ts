import { afterEach, describe, expect, it } from 'vitest';
import { isAppleTouch, lockFocusZoom } from '../../src/shared/platform/viewport';

const initial = 'width=device-width, initial-scale=1, viewport-fit=cover';

function viewport(content = initial): HTMLMetaElement {
  const meta = document.createElement('meta');
  meta.name = 'viewport';
  meta.content = content;
  document.head.append(meta);
  return meta;
}

afterEach(() => document.head.querySelectorAll('meta[name="viewport"]').forEach((meta) => meta.remove()));

describe('focus zoom lock', () => {
  it('pins the scale in the native app so a focused editor never enlarges the layout', () => {
    const meta = viewport();
    lockFocusZoom(document, true, false);
    expect(meta.content).toBe(`${initial}, maximum-scale=1`);
    // Running twice keeps a single limit.
    lockFocusZoom(document, true, false);
    expect(meta.content).toBe(`${initial}, maximum-scale=1`);
  });

  it('also pins it in iOS Safari, but leaves other browsers free to zoom', () => {
    const ios = viewport();
    lockFocusZoom(document, false, true);
    expect(ios.content).toContain('maximum-scale=1');
    ios.remove();
    const desktop = viewport();
    lockFocusZoom(document, false, false);
    expect(desktop.content).toBe(initial);
  });

  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5, true],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5, true],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0, false],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9)', 5, false],
  ])('detects Apple touch devices: %s / %i touch points', (userAgent, maxTouchPoints, expected) => {
    expect(isAppleTouch({ userAgent, maxTouchPoints })).toBe(expected);
  });
});
