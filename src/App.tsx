import { lazy, Suspense } from 'react';
import type { ComponentType } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ThemeProvider } from './ui/ThemeContext.tsx';
import { Layout } from './ui/Layout.tsx';

/**
 * Root component: theme, routing, and the persistent layout shell.
 *
 * Every route is `React.lazy`, the Playground included. Keeping it eager pulled
 * CodeMirror and React Flow — ~180 kB gzip between them — into the entry graph,
 * so a prose route like `/examples` paid for the editor and the graph library
 * it never renders (plan.md §21.5 item 5, §21.8; budgets in
 * scripts/bundle-budget.ts). The Playground chunk still renders its whole trace
 * on load — §15.1 item 1's fix is about *running* the trace, not about which
 * chunk holds it — and Vite emits a `modulepreload` for it, so `/` fetches the
 * entry and the Playground chunk in parallel rather than in a waterfall.
 * `<Suspense>` sits just inside `<Layout>`, so the disclaimer bar, nav and
 * footer stay put while a page chunk loads.
 */

/** Holds the shell's height so the footer does not jump while a chunk loads. */
function PageFallback() {
  return <div className="flex-1" aria-hidden />;
}

/** Wraps a lazy page in the one Suspense boundary every route shares. */
function suspended(Component: ComponentType) {
  return (
    <Suspense fallback={<PageFallback />}>
      <Component />
    </Suspense>
  );
}

const LandingPage = lazy(() =>
  import('./pages/LandingPage.tsx').then((m) => ({ default: m.LandingPage })),
);
const PlaygroundPage = lazy(() =>
  import('./pages/PlaygroundPage.tsx').then((m) => ({ default: m.PlaygroundPage })),
);

/**
 * `/` is the landing page — unless it carries a shared-moment query string, in
 * which case it is an old Playground link (the Playground lived at `/` until the
 * landing hub was added). Those redirect to `/playground` with the params
 * intact, so every link posted to HN, a course page or an assignment — and the
 * OG card — keeps resolving. The share keys are `src/ui/urlState.ts`'s `PARAM`
 * map, plus the legacy `sql=` the first Examples page emitted.
 */
const SHARE_KEYS = ['q', 'p', 'x', 's', 'd', 'sql'];

function IndexRoute() {
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  if (SHARE_KEYS.some((key) => params.has(key))) {
    return <Navigate to={`/playground${search}${hash}`} replace />;
  }
  return suspended(LandingPage);
}
const StagesLayout = lazy(() =>
  import('./ui/StagesLayout.tsx').then((m) => ({ default: m.StagesLayout })),
);
const StagesIndex = lazy(() =>
  import('./pages/StagesIndex.tsx').then((m) => ({ default: m.StagesIndex })),
);
const StagePage = lazy(() =>
  import('./pages/StagePage.tsx').then((m) => ({ default: m.StagePage })),
);
const ExamplesPage = lazy(() =>
  import('./pages/ExamplesPage.tsx').then((m) => ({ default: m.ExamplesPage })),
);
const GalleryPage = lazy(() =>
  import('./pages/GalleryPage.tsx').then((m) => ({ default: m.GalleryPage })),
);
const ToolsIndexPage = lazy(() =>
  import('./pages/ToolsIndexPage.tsx').then((m) => ({ default: m.ToolsIndexPage })),
);
const BufferPoolToolPage = lazy(() =>
  import('./pages/tools/BufferPoolToolPage.tsx').then((m) => ({ default: m.BufferPoolToolPage })),
);
const ParserToolPage = lazy(() =>
  import('./pages/tools/ParserToolPage.tsx').then((m) => ({ default: m.ParserToolPage })),
);
const BTreeToolPage = lazy(() =>
  import('./pages/tools/BTreeToolPage.tsx').then((m) => ({ default: m.BTreeToolPage })),
);
const PageToolPage = lazy(() =>
  import('./pages/tools/PageToolPage.tsx').then((m) => ({ default: m.PageToolPage })),
);
const SortToolPage = lazy(() =>
  import('./pages/tools/SortToolPage.tsx').then((m) => ({ default: m.SortToolPage })),
);
const PlannerToolPage = lazy(() =>
  import('./pages/tools/PlannerToolPage.tsx').then((m) => ({ default: m.PlannerToolPage })),
);
const LocksToolPage = lazy(() =>
  import('./pages/tools/LocksToolPage.tsx').then((m) => ({ default: m.LocksToolPage })),
);
const GrammarToolPage = lazy(() =>
  import('./pages/tools/GrammarToolPage.tsx').then((m) => ({ default: m.GrammarToolPage })),
);
const HashJoinToolPage = lazy(() =>
  import('./pages/tools/HashJoinToolPage.tsx').then((m) => ({ default: m.HashJoinToolPage })),
);
const ComparePage = lazy(() =>
  import('./pages/ComparePage.tsx').then((m) => ({ default: m.ComparePage })),
);
const TracePage = lazy(() =>
  import('./pages/TracePage.tsx').then((m) => ({ default: m.TracePage })),
);
const LearnPage = lazy(() =>
  import('./pages/LearnPage.tsx').then((m) => ({ default: m.LearnPage })),
);
const ProgressPage = lazy(() =>
  import('./pages/ProgressPage.tsx').then((m) => ({ default: m.ProgressPage })),
);
const ChallengesPage = lazy(() =>
  import('./pages/ChallengesPage.tsx').then((m) => ({ default: m.ChallengesPage })),
);
const ChallengePage = lazy(() =>
  import('./pages/ChallengePage.tsx').then((m) => ({ default: m.ChallengePage })),
);
const LessonPage = lazy(() =>
  import('./pages/LessonPage.tsx').then((m) => ({ default: m.LessonPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage.tsx').then((m) => ({ default: m.SettingsPage })),
);
// Unlisted (plan.md §25.4 A2): the §9 study kit's runner. Inert without a pack
// in the link's fragment; not in `routes.ts`, so no nav or footer entry.
const StudyPage = lazy(() =>
  import('./pages/StudyPage.tsx').then((m) => ({ default: m.StudyPage })),
);
const AssignmentsNewPage = lazy(() =>
  import('./pages/AssignmentsNewPage.tsx').then((m) => ({ default: m.AssignmentsNewPage })),
);
const NotFoundPage = lazy(() =>
  import('./pages/NotFoundPage.tsx').then((m) => ({ default: m.NotFoundPage })),
);
const DocsLayout = lazy(() =>
  import('./ui/DocsLayout.tsx').then((m) => ({ default: m.DocsLayout })),
);

// The docs pages are MDX/Markdown compiled to components by @mdx-js/rollup;
// each has a default export. Lazy so they form their own async chunk — folded
// into one `docs-*.js` by vite.config.ts — rather than first-paint weight.
const DocsIndex = lazy(() => import('./pages/DocsContent/index.mdx'));
const DocsGettingStarted = lazy(() => import('./pages/DocsContent/getting-started.mdx'));
const DocsFaq = lazy(() => import('./pages/DocsContent/faq.mdx'));
const DocsArchitecture = lazy(() => import('./pages/DocsContent/architecture.mdx'));
const DocsBufferPool = lazy(() => import('./pages/DocsContent/concepts/buffer-pool.mdx'));
const DocsBTree = lazy(() => import('./pages/DocsContent/concepts/btree.mdx'));
const DocsManualEviction = lazy(() => import('./pages/DocsContent/manual/eviction.mdx'));
const DocsManualBTreeSplit = lazy(() => import('./pages/DocsContent/manual/btree-split.mdx'));
const DocsSql = lazy(() => import('./pages/DocsContent/reference/sql.mdx'));
const DocsUrlParameters = lazy(() => import('./pages/DocsContent/reference/url-parameters.mdx'));
const DocsShortcuts = lazy(() => import('./pages/DocsContent/reference/shortcuts.mdx'));
const DocsLimits = lazy(() => import('./pages/DocsContent/reference/limits.mdx'));
const DocsAnswers = lazy(() => import('./pages/DocsContent/reference/answers.mdx'));

export default function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<IndexRoute />} />
            <Route path="playground" element={suspended(PlaygroundPage)} />

            <Route path="stages" element={suspended(StagesLayout)}>
              <Route index element={<StagesIndex />} />
              <Route path=":stageId" element={<StagePage />} />
            </Route>

            <Route path="learn">
              <Route index element={suspended(LearnPage)} />
              <Route path=":lessonId" element={suspended(LessonPage)} />
            </Route>

            <Route path="examples" element={suspended(ExamplesPage)} />
            <Route path="gallery" element={suspended(GalleryPage)} />
            <Route path="compare" element={suspended(ComparePage)} />
            <Route path="trace" element={suspended(TracePage)} />
            <Route path="progress" element={suspended(ProgressPage)} />
            <Route path="challenges">
              <Route index element={suspended(ChallengesPage)} />
              <Route path=":challengeId" element={suspended(ChallengePage)} />
            </Route>
            <Route path="settings" element={suspended(SettingsPage)} />
            <Route path="study" element={suspended(StudyPage)} />
            <Route path="assignments/new" element={suspended(AssignmentsNewPage)} />

            <Route path="tools">
              <Route index element={suspended(ToolsIndexPage)} />
              <Route path="buffer-pool" element={suspended(BufferPoolToolPage)} />
              <Route path="parser" element={suspended(ParserToolPage)} />
              <Route path="btree" element={suspended(BTreeToolPage)} />
              <Route path="page" element={suspended(PageToolPage)} />
              <Route path="sort" element={suspended(SortToolPage)} />
              <Route path="planner" element={suspended(PlannerToolPage)} />
              <Route path="locks" element={suspended(LocksToolPage)} />
              <Route path="grammar" element={suspended(GrammarToolPage)} />
              <Route path="hash-join" element={suspended(HashJoinToolPage)} />
            </Route>

            <Route path="docs" element={suspended(DocsLayout)}>
              <Route index element={<DocsIndex />} />
              <Route path="getting-started" element={<DocsGettingStarted />} />
              <Route path="faq" element={<DocsFaq />} />
              <Route path="concepts/buffer-pool" element={<DocsBufferPool />} />
              <Route path="concepts/btree" element={<DocsBTree />} />
              <Route path="manual/eviction" element={<DocsManualEviction />} />
              <Route path="manual/btree-split" element={<DocsManualBTreeSplit />} />
              <Route path="reference/sql" element={<DocsSql />} />
              <Route path="reference/url-parameters" element={<DocsUrlParameters />} />
              <Route path="reference/shortcuts" element={<DocsShortcuts />} />
              <Route path="reference/limits" element={<DocsLimits />} />
              <Route path="reference/answers" element={<DocsAnswers />} />
              <Route path="architecture" element={<DocsArchitecture />} />
            </Route>

            <Route path="*" element={suspended(NotFoundPage)} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
