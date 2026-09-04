import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './ui/ThemeContext.tsx';
import { Layout } from './ui/Layout.tsx';
import { StagesLayout } from './ui/StagesLayout.tsx';
import { PlaygroundPage } from './pages/PlaygroundPage.tsx';
import { StagePage } from './pages/StagePage.tsx';
import { StagesIndex } from './pages/StagesIndex.tsx';
import { ExamplesPage } from './pages/ExamplesPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';

/**
 * Root component. Sets up theme, routing, and the layout shell.
 *
 * Uses the declarative <BrowserRouter> + <Routes> pattern so that context
 * providers (like ThemeProvider) wrap the entire route tree naturally.
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
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
