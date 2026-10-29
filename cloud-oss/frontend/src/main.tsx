import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { rootApplication } from './markdownPreview';

const root = createRoot(document.getElementById('root')!);
const application = rootApplication();

if (application === 'office-preview') {
  void import('./components/OfficePreview').then(({ OfficePreviewApp }) => {
    root.render(<StrictMode><OfficePreviewApp /></StrictMode>);
  });
} else if (application === 'markdown-preview') {
  void import('./MarkdownPreviewApp').then(({ MarkdownPreviewApp }) => {
    root.render(<StrictMode><MarkdownPreviewApp /></StrictMode>);
  });
} else {
  void Promise.all([import('./App'), import('./style.css')]).then(([{ default: App }]) => {
    root.render(<StrictMode><App /></StrictMode>);
  });
}
