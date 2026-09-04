import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './ui/ThemeContext.tsx';
import { Layout } from './ui/Layout.tsx';
import { StagesLayout } from './ui/StagesLayout.tsx';
import { DocsLayout } from './ui/DocsLayout.tsx';
import { PlaygroundPage } from './pages/PlaygroundPage.tsx';
import { StagePage } from './pages/StagePage.tsx';
import { StagesIndex } from './pages/StagesIndex.tsx';
import { ExamplesPage } from './pages/ExamplesPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';

// Docs pages
import DocsIndex from './pages/DocsContent/index.mdx';
import DocsGettingStarted from './pages/DocsContent/getting-started.md';
import DocsFaq from './pages/DocsContent/faq.md';
import DocsBufferPool from './pages/DocsContent/concepts/buffer-pool.md';
import DocsBTree from './pages/DocsContent/concepts/btree.md';
import DocsSql from './pages/DocsContent/reference/sql.md';
import DocsUrlParameters from './pages/DocsContent/reference/url-parameters.md';
import DocsShortcuts from './pages/DocsContent/reference/shortcuts.md';
import DocsLimits from './pages/DocsContent/reference/limits.md';

/**
 * Root component. Sets up theme, routing, and the layout shell.
 */
export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<PlaygroundPage />} />
            <Route path="stages" element={<StagesLayout />}>
              <Route index element={<StagesIndex />} />
              <Route path=":stageId" element={<StagePage />} />
            </Route>
            <Route path="examples" element={<ExamplesPage />} />
            
            <Route path="docs" element={<DocsLayout />}>
              <Route index element={<DocsIndex />} />
              <Route path="getting-started" element={<DocsGettingStarted />} />
              <Route path="faq" element={<DocsFaq />} />
              <Route path="concepts/buffer-pool" element={<DocsBufferPool />} />
              <Route path="concepts/btree" element={<DocsBTree />} />
              <Route path="reference/sql" element={<DocsSql />} />
              <Route path="reference/url-parameters" element={<DocsUrlParameters />} />
              <Route path="reference/shortcuts" element={<DocsShortcuts />} />
              <Route path="reference/limits" element={<DocsLimits />} />
            </Route>

            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
