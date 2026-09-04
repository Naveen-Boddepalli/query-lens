import { createBrowserRouter } from 'react-router-dom';
import { Layout } from './ui/Layout.tsx';
import { StagesLayout } from './ui/StagesLayout.tsx';

// Lazy-load pages to keep the initial bundle lean. The playground is the
// landing page and loads eagerly; everything else defers until navigated.
import { PlaygroundPage } from './pages/PlaygroundPage.tsx';
import { StagePage } from './pages/StagePage.tsx';
import { StagesIndex } from './pages/StagesIndex.tsx';
import { ExamplesPage } from './pages/ExamplesPage.tsx';
import { NotFoundPage } from './pages/NotFoundPage.tsx';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <PlaygroundPage /> },
      {
        path: 'stages',
        element: <StagesLayout />,
        children: [
          { index: true, element: <StagesIndex /> },
          { path: ':stageId', element: <StagePage /> },
        ],
      },
      { path: 'examples', element: <ExamplesPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
