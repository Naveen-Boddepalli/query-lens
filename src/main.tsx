import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './ui/ErrorBoundary.tsx';
import { formatReport, installGlobalErrorHandlers, logBuildBanner } from './ui/errorReport.ts';
import './index.css';

installGlobalErrorHandlers();
logBuildBanner();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root missing from index.html');

createRoot(rootEl, {
  // React 19 routes these to console.error by default and then unmounts the
  // tree — which is the blank page plan.md §14.1 item 3 is about. The boundary
  // below renders the fallback; these hooks make sure the same report reaches
  // the console for the errors React logs but does not surface (§14.4: the
  // console is the only sink, because there is no telemetry).
  onUncaughtError: (error, info) => {
    console.error('[QueryLens] uncaught render error\n\n' + formatReport(error, info.componentStack));
  },
  onRecoverableError: (error, info) => {
    console.warn('[QueryLens] recovered from\n\n' + formatReport(error, info.componentStack));
  },
}).render(
  <StrictMode>
    <ErrorBoundary variant="page">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
