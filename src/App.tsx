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

/** A lazy page: the module's named export `name`, loaded the first time its route is visited. */
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}

const LandingPage = page(() => import('./pages/LandingPage.tsx'), 'LandingPage');
const PlaygroundPage = page(() => import('./pages/PlaygroundPage.tsx'), 'PlaygroundPage');

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
const StagesLayout = page(() => import('./ui/StagesLayout.tsx'), 'StagesLayout');
const StagesIndex = page(() => import('./pages/StagesIndex.tsx'), 'StagesIndex');
const StagePage = page(() => import('./pages/StagePage.tsx'), 'StagePage');
const ExamplesPage = page(() => import('./pages/ExamplesPage.tsx'), 'ExamplesPage');
const GalleryPage = page(() => import('./pages/GalleryPage.tsx'), 'GalleryPage');
const ToolsIndexPage = page(() => import('./pages/ToolsIndexPage.tsx'), 'ToolsIndexPage');
/** Every tool page, by its path under `/tools`, each its own lazy chunk. A table, not 22 routes written out: the
 *  entry chunk every page pays carries it (plan.md §25.4 H8 keeps that under 24 kB). */
const TOOL_PAGES: Record<string, ComponentType> = {
  'buffer-pool': page(() => import('./pages/tools/BufferPoolToolPage.tsx'), 'BufferPoolToolPage'),
  parser: page(() => import('./pages/tools/ParserToolPage.tsx'), 'ParserToolPage'),
  btree: page(() => import('./pages/tools/BTreeToolPage.tsx'), 'BTreeToolPage'),
  page: page(() => import('./pages/tools/PageToolPage.tsx'), 'PageToolPage'),
  sort: page(() => import('./pages/tools/SortToolPage.tsx'), 'SortToolPage'),
  planner: page(() => import('./pages/tools/PlannerToolPage.tsx'), 'PlannerToolPage'),
  locks: page(() => import('./pages/tools/LocksToolPage.tsx'), 'LocksToolPage'),
  schedule: page(() => import('./pages/tools/ScheduleToolPage.tsx'), 'ScheduleToolPage'),
  isolation: page(() => import('./pages/tools/IsolationToolPage.tsx'), 'IsolationToolPage'),
  concurrency: page(() => import('./pages/tools/ConcurrencyToolPage.tsx'), 'ConcurrencyToolPage'),
  wal: page(() => import('./pages/tools/WalToolPage.tsx'), 'WalToolPage'),
  recovery: page(() => import('./pages/tools/RecoveryToolPage.tsx'), 'RecoveryToolPage'),
  grammar: page(() => import('./pages/tools/GrammarToolPage.tsx'), 'GrammarToolPage'),
  'hash-join': page(() => import('./pages/tools/HashJoinToolPage.tsx'), 'HashJoinToolPage'),
  'join-order': page(() => import('./pages/tools/JoinOrderToolPage.tsx'), 'JoinOrderToolPage'),
  histograms: page(() => import('./pages/tools/HistogramToolPage.tsx'), 'HistogramToolPage'),
  parallel: page(() => import('./pages/tools/ParallelToolPage.tsx'), 'ParallelToolPage'),
  partitioning: page(() => import('./pages/tools/PartitioningToolPage.tsx'), 'PartitioningToolPage'),
  lsm: page(() => import('./pages/tools/LsmToolPage.tsx'), 'LsmToolPage'),
  'hash-index': page(() => import('./pages/tools/HashIndexToolPage.tsx'), 'HashIndexToolPage'),
  columnar: page(() => import('./pages/tools/ColumnarToolPage.tsx'), 'ColumnarToolPage'),
  'latch-crabbing': page(() => import('./pages/tools/LatchCrabbingToolPage.tsx'), 'LatchCrabbingToolPage'),
  'vector-index': page(() => import('./pages/tools/VectorIndexToolPage.tsx'), 'VectorIndexToolPage'),
};
const ComparePage = page(() => import('./pages/ComparePage.tsx'), 'ComparePage');
const TracePage = page(() => import('./pages/TracePage.tsx'), 'TracePage');
const LearnPage = page(() => import('./pages/LearnPage.tsx'), 'LearnPage');
const ProgressPage = page(() => import('./pages/ProgressPage.tsx'), 'ProgressPage');
const PracticePage = page(() => import('./pages/PracticePage.tsx'), 'PracticePage');
const ChallengesPage = page(() => import('./pages/ChallengesPage.tsx'), 'ChallengesPage');
const ChallengePage = page(() => import('./pages/ChallengePage.tsx'), 'ChallengePage');
const LessonPage = page(() => import('./pages/LessonPage.tsx'), 'LessonPage');
const SettingsPage = page(() => import('./pages/SettingsPage.tsx'), 'SettingsPage');
// Unlisted (plan.md §25.4 A2): the §9 study kit's runner. Inert without a pack
// in the link's fragment; not in `routes.ts`, so no nav or footer entry.
const StudyPage = page(() => import('./pages/StudyPage.tsx'), 'StudyPage');
const AssignmentsNewPage = page(() => import('./pages/AssignmentsNewPage.tsx'), 'AssignmentsNewPage');
const NotFoundPage = page(() => import('./pages/NotFoundPage.tsx'), 'NotFoundPage');
const DocsLayout = page(() => import('./ui/DocsLayout.tsx'), 'DocsLayout');

// The docs pages are MDX/Markdown compiled to components by @mdx-js/rollup;
// each has a default export. Lazy so they form their own async chunk — folded
// into one `docs-*.js` by vite.config.ts — rather than first-paint weight.
const DocsIndex = lazy(() => import('./pages/DocsContent/index.mdx'));
/** Every docs page but the index, by its path under `/docs`: MDX, each its own lazy chunk. A table for the same reason
 *  as `TOOL_PAGES`. */
const DOC_PAGES: Record<string, ComponentType> = {
  'getting-started': lazy(() => import('./pages/DocsContent/getting-started.mdx')),
  'faq': lazy(() => import('./pages/DocsContent/faq.mdx')),
  'concepts/buffer-pool': lazy(() => import('./pages/DocsContent/concepts/buffer-pool.mdx')),
  'concepts/btree': lazy(() => import('./pages/DocsContent/concepts/btree.mdx')),
  'essays/index-write-tax': lazy(() => import('./pages/DocsContent/essays/index-write-tax.mdx')),
  'essays/scan-resistance': lazy(() => import('./pages/DocsContent/essays/scan-resistance.mdx')),
  'essays/repeatable-read': lazy(() => import('./pages/DocsContent/essays/repeatable-read.mdx')),
  'accessibility': lazy(() => import('./pages/DocsContent/accessibility.mdx')),
  'manual/eviction': lazy(() => import('./pages/DocsContent/manual/eviction.mdx')),
  'manual/btree-split': lazy(() => import('./pages/DocsContent/manual/btree-split.mdx')),
  'study/course-map': lazy(() => import('./pages/DocsContent/study/course-map.mdx')),
  'study/interview-roadmap': lazy(() => import('./pages/DocsContent/study/interview-roadmap.mdx')),
  'reference/sql': lazy(() => import('./pages/DocsContent/reference/sql.mdx')),
  'reference/url-parameters': lazy(() => import('./pages/DocsContent/reference/url-parameters.mdx')),
  'reference/shortcuts': lazy(() => import('./pages/DocsContent/reference/shortcuts.mdx')),
  'reference/limits': lazy(() => import('./pages/DocsContent/reference/limits.mdx')),
  'reference/answers': lazy(() => import('./pages/DocsContent/reference/answers.mdx')),
  'architecture': lazy(() => import('./pages/DocsContent/architecture.mdx')),
};

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
              <Route path="practice" element={suspended(PracticePage)} />
            <Route path="challenges">
              <Route index element={suspended(ChallengesPage)} />
              <Route path=":challengeId" element={suspended(ChallengePage)} />
            </Route>
            <Route path="settings" element={suspended(SettingsPage)} />
            <Route path="study" element={suspended(StudyPage)} />
            <Route path="assignments/new" element={suspended(AssignmentsNewPage)} />

            <Route path="tools">
              <Route index element={suspended(ToolsIndexPage)} />
              {Object.entries(TOOL_PAGES).map(([path, Tool]) => (
                <Route key={path} path={path} element={suspended(Tool)} />
              ))}
            </Route>

            <Route path="docs" element={suspended(DocsLayout)}>
              <Route index element={<DocsIndex />} />
              {Object.entries(DOC_PAGES).map(([path, Doc]) => (
                <Route key={path} path={path} element={<Doc />} />
              ))}
            </Route>

            <Route path="*" element={suspended(NotFoundPage)} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
