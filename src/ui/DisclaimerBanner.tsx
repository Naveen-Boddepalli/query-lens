/**
 * Persistent, not footer text. plan.md §12 names an unmistakable "simplified
 * model" framing as a top risk — a learner must never mistake this for a
 * faithful account of Postgres or InnoDB.
 */
export function DisclaimerBanner() {
  return (
    <p className="border-b border-edge bg-surface-2 px-4 py-1.5 text-center text-xs text-ink-dim">
      QueryLens runs a{' '}
      <strong className="font-medium text-ink">simplified educational model</strong> of
      database internals. Every number shown is true to <em>this</em> engine — not to the
      exact behaviour of Postgres, MySQL, or any production database.
    </p>
  );
}
