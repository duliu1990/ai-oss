import { createElement } from 'react';
import type { ComponentProps } from 'react';
import DriveModule from '../../src/modules/drive/DriveModule';
import driveCss from '../../src/modules/drive/drive.css?raw';
import sharedCss from '../../src/shared/shared.css?raw';
import themeCss from '../../src/shared/theme.css?raw';
import { tokens } from '../../src/shared/session';
import { ToastProvider } from '../../src/shared/Toast';
import { vi } from 'vitest';

/** Every stylesheet the shell loads for the drive, in the shell's order. */
export const driveStyles = [themeCss, sharedCss, driveCss].join('\n');

/** The drive as the shell mounts it: signed in, inside the shell's toast provider. */
export function driveApp(props: ComponentProps<typeof DriveModule> = {}) {
  vi.spyOn(tokens, 'token').mockReturnValue('unit-test-token');
  return createElement(ToastProvider, null, createElement(DriveModule, props));
}
