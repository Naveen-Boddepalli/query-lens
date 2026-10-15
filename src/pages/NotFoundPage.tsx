import { Link } from 'react-router-dom';
import { btnPrimary, btnSecondary, panelSurface } from '../ui/primitives.ts';

const LINKS = [
  ['/playground', 'Playground'],
  ['/stages', 'Stages'],
  ['/docs', 'Docs'],
  ['/learn', 'Lessons'],
] as const;

export function NotFoundPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6 text-center">
      <div className={`w-full max-w-md p-8 ${panelSurface}`}>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface-3/80 px-2.5 py-0.5 font-mono text-[11px] text-ink-dim shadow-neu-rest backdrop-blur-sm">
          <span className="h-1.5 w-1.5 rounded-full bg-evict" aria-hidden="true" />
          404 · Unresolved Pointer
        </span>
        <p
          className="mt-4 font-mono text-hero font-bold tracking-tight text-ink-dim"
          style={{ textShadow: '0 0 32px var(--color-accent-soft)' }}
        >
          404
        </p>
        <h1 className="mt-1 text-heading font-semibold text-ink">This node has no child pointer</h1>
        <p className="mt-2 text-label text-ink-dim leading-relaxed">
          The requested page does not exist. Index traversal reached a leaf boundary with no record pointer.
        </p>
        <div className="mt-5 border-t border-edge/60 pt-4">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-dim">Suggestions</p>
          <div className="flex flex-wrap justify-center gap-1.5">
            {LINKS.map(([to, label]) => (
              <Link
                key={to}
                to={to}
                className="rounded-md border border-edge bg-surface-3/60 px-2.5 py-1 text-label text-ink transition hover:border-accent/40 hover:bg-surface-3"
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <Link to="/playground" className={btnPrimary}>Back to Playground</Link>
          <Link to="/" className={btnSecondary}>Go home</Link>
        </div>
      </div>
    </main>
  );
}

