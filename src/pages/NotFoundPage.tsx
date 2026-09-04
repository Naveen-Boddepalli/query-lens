import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="font-mono text-display text-ink-dim">404</p>
      <h2 className="text-heading font-semibold">Page not found</h2>
      <p className="max-w-md text-body text-ink-dim">
        The page you're looking for doesn't exist. It may have been moved or the URL might
        be wrong.
      </p>
      <Link
        to="/"
        className="mt-2 rounded-md border border-accent bg-accent/15 px-4 py-2 text-body font-medium text-ink transition-colors hover:bg-accent/25"
      >
        Back to Playground
      </Link>
    </div>
  );
}
