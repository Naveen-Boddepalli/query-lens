import { NavLink } from 'react-router-dom';
import { ThemeToggle } from './ThemeToggle.tsx';
import { useThemeContext } from './ThemeContext.tsx';

const NAV_ITEMS = [
  { to: '/', label: 'Playground' },
  { to: '/stages', label: 'Stages' },
  { to: '/examples', label: 'Examples' },
] as const;

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

      <nav aria-label="Main navigation" className="ml-auto flex items-center gap-1">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              [
                'rounded-md px-3 py-1.5 text-label font-medium transition-colors',
                isActive
                  ? 'bg-accent/15 text-ink'
                  : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
              ].join(' ')
            }
          >
            {item.label}
          </NavLink>
        ))}
        <NavLink
          to="/docs"
          className={({ isActive }) =>
            [
              'rounded-md px-3 py-1.5 text-label font-medium transition-colors',
              isActive
                ? 'bg-accent/15 text-ink'
                : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
            ].join(' ')
          }
        >
          Docs
        </NavLink>
      </nav>

      <ThemeToggle choice={choice} setChoice={setChoice} />
    </header>
  );
}
