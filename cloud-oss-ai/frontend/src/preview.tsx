import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OfficePreviewApp } from './modules/drive/components/OfficePreview';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <OfficePreviewApp />
  </StrictMode>,
);
