import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from '../routes.ts';
import { Logo } from './Logo.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';
import { useThemeContext } from './ThemeContext.tsx';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'rounded-full px-3 py-1.5 text-label font-medium transition',
    isActive
      ? 'bg-accent-soft text-ink shadow-e1'
      : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
  ].join(' ');

const PRIMARY_ITEMS = NAV_ITEMS.filter((item) => item.nav);

export function TopNav() {
  const { choice, setChoice } = useThemeContext();

  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge bg-surface/80 px-4 py-3 backdrop-blur-md">
      <NavLink to="/" className="flex items-center gap-2.5 text-ink transition hover:opacity-90">
        <Logo className="h-7 w-7 shrink-0" />
        <h1 className="text-display font-semibold tracking-tight">QueryLens</h1>
      </NavLink>

      {/* One list, from src/routes.tsx — the footer reads the same source, so a
          route cannot appear here and go missing there (plan.md §21.5 item 6). */}
      <nav aria-label="Main navigation" className="ml-auto flex flex-wrap items-center gap-0.5">
        {PRIMARY_ITEMS.map((item) => (
          <NavLink key={item.path} to={item.path} className={linkClass}>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <ThemeToggle choice={choice} setChoice={setChoice} />
    </header>
  );
}
