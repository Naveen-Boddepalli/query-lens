import { Outlet } from 'react-router-dom';
import { DisclaimerBanner } from './DisclaimerBanner.tsx';
import { TopNav } from './TopNav.tsx';
import { Footer } from './Footer.tsx';

/**
 * Root layout shell — persistent across all pages: disclaimer bar, top nav, the
 * routed page (`<Outlet />`), footer.
 *
 * The nav+content block is the part that is exactly one viewport tall on
 * desktop (`lg:h-dvh lg:overflow-hidden`) — load-bearing, and was lost when
 * routing moved the shell out of `App.tsx` in `5c7ef5d` (plan.md §21.1 —
 * routing landed half-wired). Without it, PlaygroundPage's `<main
 * lg:min-h-0>` has no bounded ancestor, so a long result grows the page
 * instead of scrolling its panel — the regression §15.5 caught and
 * `e2e/regressions.spec.ts` guards.
 *
 * The footer sits *outside* that bounded block on purpose, since its own
 * docstring calls it "the quiet way deeper, below the fold" — a multi-column
 * footer (plan.md §16.2 item 9) is tall enough now that folding it inside the
 * fixed-height shell would shrink the Playground's usable height on every
 * load, exactly the "stealing space from the app" failure §19 warns against.
 * A desktop visitor scrolls past one full viewport of app to reach it; a
 * first-time visitor, who never scrolls, never sees the tradeoff at all.
 *
 * `snap-sections` arms the mobile scroll-snap (§16.2 item 10) that
 * PlaygroundPage's `.snap-section` children expect; it is inert on desktop.
 */
export function Layout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="snap-sections flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
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
