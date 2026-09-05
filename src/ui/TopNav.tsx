import { NavLink } from 'react-router-dom';
import { NAV_ITEMS } from '../routes.ts';
import { ThemeToggle } from './ThemeToggle.tsx';
import { useThemeContext } from './ThemeContext.tsx';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'rounded-md px-3 py-1.5 text-label font-medium transition-colors',
    isActive ? 'bg-accent/15 text-ink' : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
  ].join(' ');

const PRIMARY_ITEMS = NAV_ITEMS.filter((item) => item.nav);

export function TopNav() {
  const { choice, setChoice } = useThemeContext();

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-edge px-4 py-3">
      <NavLink to="/" className="flex items-baseline gap-x-3">
        <h1 className="text-display font-semibold tracking-tight">QueryLens</h1>
        <p className="hidden text-label text-ink-dim sm:block">
          Watch a SQL query become a B+Tree traversal.
        </p>
      </NavLink>

      {/* One list, from src/routes.tsx — the footer reads the same source, so a
          route cannot appear here and go missing there (plan.md §21.5 item 6). */}
      <nav aria-label="Main navigation" className="ml-auto flex flex-wrap items-center gap-1">
        {PRIMARY_ITEMS.map((item) => (
          <NavLink key={item.path} to={item.path} end={item.end ?? false} className={linkClass}>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <ThemeToggle choice={choice} setChoice={setChoice} />
    </header>
  );
}
