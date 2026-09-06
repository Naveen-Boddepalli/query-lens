import { Link } from 'react-router-dom';
import { btnPrimary, btnGhost } from '../ui/primitives.ts';

export function NotFoundPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <p
        className="font-mono text-hero font-semibold text-ink-dim"
        style={{ textShadow: '0 0 40px var(--color-accent-soft)' }}
      >
        404
      </p>
      <h2 className="text-heading font-semibold text-ink">This node has no child pointer</h2>
      <p className="max-w-md text-body text-ink-dim">
        The page you're looking for doesn't exist — the URL might be wrong, or it may have moved.
        Head back to the Playground and start a trace.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <Link to="/playground" className={btnPrimary}>
          Back to the Playground
        </Link>
        <Link to="/" className={btnGhost}>
          Go home
        </Link>
      </div>
    </div>
  );
}
