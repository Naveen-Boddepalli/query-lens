import { lazy, Suspense, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { DisclaimerBanner } from './DisclaimerBanner.tsx';
import { FirstVisitHint } from './FirstVisitHint.tsx';
import { TopNav } from './TopNav.tsx';
import { OPEN_SPOTLIGHT_EVENT } from './spotlight.ts';

/**
 * The footer is below the fold on every page, and carries the docs site's navigation: fetched after the page itself,
 * not as part of the shell every route waits for (plan.md §25.4 H8 keeps that small).
 */
const Footer = lazy(() => import('./Footer.tsx').then((m) => ({ default: m.Footer })));

const SpotlightDialog = lazy(() =>
  import('./SpotlightDialog.tsx').then((m) => ({ default: m.SpotlightDialog })),
);

/**
 * Root layout shell — persistent across all pages: disclaimer bar, top nav, the
 * routed page (`<Outlet />`), footer.
 *
 * The nav+content block (`data-app-shell`) is exactly one viewport tall on
 * desktop for every route *except* the landing page: `lg:h-dvh
 * lg:overflow-hidden` is what keeps a long Playground result scrolling inside
 * its own panel rather than growing the page (the regression §15.5 caught,
 * `e2e/regressions.spec.ts` guards). The landing (`/`) is a normal tall
 * document — hero, intro, tool cards, footer — so it opts out and scrolls the
 * window, which also lets the sticky `TopNav` behave like a real site header
 * there.
 *
 * `snap-sections` arms the mobile scroll-snap (§16.2 item 10) that
 * PlaygroundPage's `.snap-section` children expect; it is inert elsewhere.
 *
 * `/study` is a kiosk (plan.md §25.4 A2): no disclaimer bar, nav or footer. A
 * control-arm participant reading a fixed text must not be one click from the
 * app's own explanation of the same material — that would contaminate the very
 * comparison the study exists to make — and an app-arm participant reaches the
 * lessons through the page's own links, in new tabs.
 */
export function Layout() {
  const { pathname, search } = useLocation();
  const isLanding = pathname === '/';
  const isStudy = pathname === '/study';
  const [isSpotlightOpen, setIsSpotlightOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isStudy) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsSpotlightOpen((open) => !open);
      }
    };

    const handleOpen = () => {
      if (!isStudy) setIsSpotlightOpen(true);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener(OPEN_SPOTLIGHT_EVENT, handleOpen);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(OPEN_SPOTLIGHT_EVENT, handleOpen);
    };
  }, [isStudy]);

  // The first-visit hint (plan.md §19.2) belongs on the app's own front door
  // only: `/playground` with nothing in the URL. A shared-moment link
  // (`?q=…`) is someone else's onboarding, not a cold first visit.
  const showHint = pathname === '/playground' && search === '';

  return (
    <div className="relative flex min-h-dvh flex-col bg-surface text-ink antialiased selection:bg-accent-soft selection:text-ink">
      <div
        data-app-shell
        className={[
          'snap-sections flex min-h-dvh w-full min-w-0 max-w-full flex-col',
          isLanding ? '' : 'lg:h-dvh lg:overflow-hidden',
        ].join(' ')}
      >
        {/* The brand line: the eight stage colours, end to end. */}
        {!isStudy && <div aria-hidden="true" className="ql-spectrum-line shrink-0" />}
        {!isStudy && <DisclaimerBanner />}
        {!isStudy && <TopNav />}
        {showHint && <FirstVisitHint />}
        {/* `overflow-y-auto` here, not on the shell: most routed pages (Learn,
            Examples, Settings, …) are plain prose taller than one viewport and
            have no internal scroll container of their own, so without this they
            were simply clipped by the shell's `lg:overflow-hidden` above with no
            way to reach the rest of the page. Playground and the /stages and
            /docs layouts size themselves to fit exactly (or scroll a nested
            panel), so this never shows a second scrollbar for them. Only from
            `lg` up, where the shell is pinned to the viewport: below it the
            window scrolls, and a pane that only claimed to scroll became the
            scroll container `position: sticky` measured against, so a tool's
            transport never stuck to the bottom of a phone screen. */}
        <div className="flex min-h-0 min-w-0 w-full max-w-full flex-1 lg:overflow-y-auto">
          <Outlet />
        </div>
      </div>
      {!isStudy && (
        <Suspense fallback={null}>
          <Footer />
        </Suspense>
      )}
      {!isStudy && isSpotlightOpen && (
        <Suspense fallback={null}>
          <SpotlightDialog onClose={() => setIsSpotlightOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
