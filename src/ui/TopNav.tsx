import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { REPO_URL } from '../buildInfo.ts';
import { NAV_ITEMS } from '../routes.ts';
import { Logo, VersionBadge } from './Logo.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { useThemeContext } from './ThemeContext.tsx';

const desktopLinkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'inline-flex items-center rounded-lg px-2.5 py-1.5 text-label font-medium transition duration-150 ease-out select-none',
    isActive
      ? 'border border-accent/40 bg-accent-soft text-ink shadow-neu-rest'
      : 'border border-transparent text-ink-dim hover:border-edge hover:bg-surface-2/60 hover:text-ink',
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
    <header className="ql-glass-header sticky top-0 z-30 flex w-full max-w-full min-w-0 flex-col border-b border-edge bg-surface/85 backdrop-blur-md">
      <div className="flex w-full max-w-full min-w-0 items-center justify-between gap-x-2 sm:gap-x-4 px-3 sm:px-4 py-2.5">
        {/* Brand Lockup */}
        <div className="flex min-w-0 shrink items-center gap-2">
          <NavLink
            to="/"
            className="flex min-w-0 shrink items-center gap-2 sm:gap-2.5 text-ink transition hover:opacity-90"
          >
            <Logo className="h-7 w-7 shrink-0" />
            <h1 className="text-display font-semibold tracking-tight">QueryLens</h1>
          </NavLink>
          <VersionBadge className="hidden sm:inline-flex" />
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
          {/* Client-Side Engine Status Badge */}
          <div
            className="hidden xl:inline-flex items-center gap-2 rounded-full border border-edge bg-surface-2/80 px-2.5 py-1 text-xs font-mono text-ink-dim shadow-neu-rest backdrop-blur-sm select-none"
            title="QueryLens engine executes 100% in-browser in WebAssembly / TypeScript"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-hit opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-hit" />
            </span>
            <span>Engine: In-Memory WASM</span>
          </div>

          {/* GitHub Repository Link & Star Counter */}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            title="GitHub Repository (4.2k stars)"
            className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-edge bg-surface-2/80 px-2.5 py-1.5 text-xs font-mono text-ink-dim shadow-neu-rest backdrop-blur-sm transition duration-150 ease-out hover:border-ink-dim/50 hover:bg-surface-3 hover:text-ink active:translate-y-px"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4 fill-currentColor shrink-0" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span className="hidden sm:inline-flex items-center gap-1 border-l border-edge pl-1.5 text-ink-dim">
              <svg viewBox="0 0 16 16" className="h-3 w-3 fill-accent opacity-80" aria-hidden="true">
                <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z" />
              </svg>
              4.2k
            </span>
          </a>

          {/* Theme Mode Segmented Controller */}
          <ThemeToggle choice={choice} setChoice={setChoice} />

          {/* Mobile Drawer Hamburger Button */}
          <button
            type="button"
            onClick={() => setIsMobileOpen((prev) => !prev)}
            aria-label={isMobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={isMobileOpen}
            aria-controls="mobile-nav-drawer"
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-edge bg-surface-2/80 text-ink-dim shadow-neu-rest backdrop-blur-sm transition duration-150 ease-out hover:border-ink-dim/50 hover:bg-surface-3 hover:text-ink active:translate-y-px lg:hidden"
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
          <nav aria-label="Mobile navigation" className="flex flex-col gap-1">
            {PRIMARY_ITEMS.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  [
                    'flex items-center justify-between rounded-lg px-3 py-2 text-body font-medium transition duration-150 ease-out',
                    isActive
                      ? 'border border-accent/40 bg-accent-soft text-ink shadow-neu-rest'
                      : 'border border-transparent text-ink-dim hover:border-edge hover:bg-surface-2/60 hover:text-ink',
                  ].join(' ')
                }
              >
                <span>{item.label}</span>
                <span className="font-mono text-xs text-ink-dim/60">→</span>
              </NavLink>
            ))}
          </nav>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-edge pt-3 text-xs font-mono">
            <div className="flex items-center gap-2 text-ink-dim">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-hit opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-hit" />
              </span>
              <span>Engine: In-Memory WASM</span>
            </div>
            <VersionBadge />
          </div>
        </div>
      )}
    </header>
  );
}
