import { Outlet, useLocation } from 'react-router-dom';
import { DisclaimerBanner } from './DisclaimerBanner.tsx';
import { TopNav } from './TopNav.tsx';
import { Footer } from './Footer.tsx';

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
 */
export function Layout() {
  const isLanding = useLocation().pathname === '/';

  return (
    <div className="flex min-h-dvh flex-col">
      <div
        data-app-shell
        className={[
          'snap-sections flex min-h-dvh flex-col',
          isLanding ? '' : 'lg:h-dvh lg:overflow-hidden',
        ].join(' ')}
      >
        <DisclaimerBanner />
        <TopNav />
        <div className="flex min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
      <Footer />
    </div>
  );
}
