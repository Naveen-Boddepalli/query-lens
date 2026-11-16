import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { NAV_ITEMS } from '../routes.ts';
import { Logo } from './Logo.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { useThemeContext } from './ThemeContext.tsx';
import { openSpotlight } from './spotlight.ts';
import { MOD_KEY } from './platform.ts';

const desktopLinkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'relative inline-flex items-center rounded-full px-3 py-1.5 text-label font-medium transition duration-150 ease-out select-none',
    isActive
      ? 'bg-accent-soft text-ink ring-1 ring-inset ring-accent/40'
      : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
  ].join(' ');

const PRIMARY_ITEMS = NAV_ITEMS.filter((item) => item.nav);

export function TopNav() {
  const { choice, setChoice } = useThemeContext();
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const location = useLocation();

  const [prevPathname, setPrevPathname] = useState(location.pathname);

  // Close mobile drawer upon route navigation
  if (prevPathname !== location.pathname) {
    setPrevPathname(location.pathname);
    setIsMobileOpen(false);
  }

  // Close mobile drawer on Escape key press
  useEffect(() => {
    if (!isMobileOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsMobileOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMobileOpen]);

  return (
    <header className="sticky top-0 z-30 flex w-full max-w-full min-w-0 flex-col border-b border-edge/70 bg-surface/80 backdrop-blur-xl backdrop-saturate-150">
      <div className="flex w-full max-w-full min-w-0 items-center justify-between gap-x-2 sm:gap-x-4 px-3 sm:px-4 py-2.5">
        {/* Brand Lockup */}
        <div className="flex min-w-0 shrink items-center gap-2">
          <NavLink
            to="/"
            className="flex min-w-0 shrink items-center gap-2 sm:gap-2.5 text-ink transition hover:opacity-90"
          >
            <Logo className="h-7 w-7 shrink-0" />
            <h1 className="text-heading font-semibold tracking-tight">
              Query<span className="ql-spectrum-text">Lens</span>
            </h1>
          </NavLink>
        </div>

        {/* Primary Desktop Navigation */}
        <nav aria-label="Main navigation" className="hidden lg:flex items-center gap-0.5">
          {PRIMARY_ITEMS.map((item) => (
            <NavLink key={item.path} to={item.path} className={desktopLinkClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Actions & Utilities Toolbar */}
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {/* Spotlight Search Trigger Button */}
          <button
            type="button"
            onClick={openSpotlight}
            className="ql-liquid-pill group flex items-center justify-between h-9 px-2.5 sm:px-3.5 lg:px-2.5 xl:px-3.5 w-9 sm:w-40 lg:w-9 xl:w-48 rounded-full backdrop-blur-md text-ink-dim hover:text-ink cursor-pointer"
            aria-label={`Spotlight search (${MOD_KEY === '⌘' ? 'Command' : 'Control'}+K)`}
            aria-keyshortcuts="Meta+K Control+K"
          >
            <div className="flex items-center gap-2 min-w-0">
              <svg
                className="h-4 w-4 shrink-0 stroke-current stroke-2 text-ink-dim group-hover:text-accent transition-colors"
                viewBox="0 0 20 20"
                fill="none"
                aria-hidden="true"
              >
                <circle cx="8.5" cy="8.5" r="5.5" />
                <path d="M13 13l4.5 4.5" strokeLinecap="round" />
              </svg>
              <span className="hidden sm:inline lg:hidden xl:inline text-label text-ink-dim group-hover:text-ink truncate">
                Search...
              </span>
            </div>
            <kbd
              aria-hidden="true"
              className="ql-liquid-kbd hidden sm:inline-flex lg:hidden xl:inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] text-ink-dim group-hover:text-ink transition-colors"
            >
              {MOD_KEY}K
            </kbd>
          </button>

          {/* Theme Mode Segmented Controller */}
          <ThemeToggle choice={choice} setChoice={setChoice} />

          {/* Mobile Drawer Hamburger Button */}
          <button
            type="button"
            onClick={() => setIsMobileOpen((prev) => !prev)}
            aria-label={isMobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={isMobileOpen}
            aria-controls="mobile-nav-drawer"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-edge bg-surface-2 text-ink-dim shadow-e1 transition duration-150 ease-out hover:bg-surface-3 hover:text-ink active:translate-y-px lg:hidden"
          >
            {isMobileOpen ? (
              <svg viewBox="0 0 20 20" className="h-4 w-4 stroke-current stroke-2" fill="none" aria-hidden="true">
                <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 20 20" className="h-4 w-4 stroke-current stroke-2" fill="none" aria-hidden="true">
                <path d="M3.5 5h13M3.5 10h13M3.5 15h13" strokeLinecap="round" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Accessible Mobile Navigation Drawer */}
      {isMobileOpen && (
        <div
          id="mobile-nav-drawer"
          className="w-full border-t border-edge bg-surface/95 px-4 py-4 shadow-e3 backdrop-blur-xl lg:hidden"
        >
          <button
            type="button"
            onClick={() => {
              setIsMobileOpen(false);
              openSpotlight();
            }}
            className="flex w-full items-center justify-between rounded-lg border border-edge bg-surface-2 px-3 py-2 text-body text-ink-dim shadow-e1 hover:bg-surface-3 hover:text-ink transition duration-150 mb-3 cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <svg className="h-4 w-4 shrink-0 stroke-current stroke-2 text-accent" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="8.5" cy="8.5" r="5.5" />
                <path d="M13 13l4.5 4.5" strokeLinecap="round" />
              </svg>
              <span className="font-medium text-ink">Spotlight search...</span>
            </div>
            <kbd className="rounded border border-edge bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-dim">
              {MOD_KEY}K
            </kbd>
          </button>
          <nav aria-label="Mobile navigation" className="flex flex-col gap-1">
            {PRIMARY_ITEMS.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  [
                    'flex items-center justify-between rounded-lg px-3 py-2 text-body font-medium transition duration-150 ease-out',
                    isActive
                      ? 'border border-accent/40 bg-accent-soft text-ink shadow-e1'
                      : 'border border-transparent text-ink-dim hover:bg-surface-3 hover:text-ink',
                  ].join(' ')
                }
              >
                <span>{item.label}</span>
                <span className="font-mono text-xs text-ink-dim/60">→</span>
              </NavLink>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}
