import { Outlet } from 'react-router-dom';
import { DisclaimerBanner } from './DisclaimerBanner.tsx';
import { TopNav } from './TopNav.tsx';
import { Footer } from './Footer.tsx';

/**
 * Root layout shell — persistent across all pages: disclaimer bar, top nav, the
 * routed page (`<Outlet />`), footer.
 *
 * `lg:h-dvh lg:overflow-hidden` is load-bearing and was lost when routing moved
 * the shell out of `App.tsx` in `5c7ef5d` (plan.md §21.1 — routing landed
 * half-wired). On desktop the shell is a fixed-height box and each page scrolls
 * inside it; without it, PlaygroundPage's `<main lg:min-h-0>` has no bounded
 * ancestor, so a long result grows the page instead of scrolling its panel —
 * exactly the regression §15.5 caught and `e2e/regressions.spec.ts` guards.
 * `snap-sections` is the other half: it arms the mobile scroll-snap (§16.2
 * item 10) that PlaygroundPage's `.snap-section` children expect.
 */
export function Layout() {
  return (
    <div className="snap-sections flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <DisclaimerBanner />
      <TopNav />
      <div className="flex min-h-0 flex-1">
        <Outlet />
      </div>
      <Footer />
    </div>
  );
}
