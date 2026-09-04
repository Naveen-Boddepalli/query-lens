import { Outlet } from 'react-router-dom';
import { DisclaimerBanner } from './DisclaimerBanner.tsx';
import { TopNav } from './TopNav.tsx';
import { Footer } from './Footer.tsx';

/**
 * Root layout shell — persistent across all pages.
 *
 * Renders the disclaimer banner, top navigation, the routed page content
 * (via Outlet), and the footer. This is the React Flow-style shell: a
 * fixed nav at the top with page content flowing below it.
 */
export function Layout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <DisclaimerBanner />
      <TopNav />
      <div className="flex min-h-0 flex-1">
        <Outlet />
      </div>
      <Footer />
    </div>
  );
}
