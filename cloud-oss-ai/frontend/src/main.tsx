import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { rootApplication } from './modules/drive/markdownPreview';
import { lockFocusZoom } from './shared/platform/viewport';

lockFocusZoom();

const root = createRoot(document.getElementById('root')!);
const application = rootApplication();

if (application === 'office-preview') {
  void import('./modules/drive/components/OfficePreview').then(({ OfficePreviewApp }) => {
    root.render(<StrictMode><OfficePreviewApp /></StrictMode>);
  });
} else if (application === 'markdown-preview') {
  void import('./modules/drive/MarkdownPreviewApp').then(({ MarkdownPreviewApp }) => {
    root.render(<StrictMode><MarkdownPreviewApp /></StrictMode>);
  });
} else {
  // Preview windows never load the shell, the player or their styles.
  void import('./shell/start').then(({ start }) => start(root));
}
