/**
 * Persistent, not footer text. plan.md §12 names an unmistakable "simplified
 * model" framing as a top risk — a learner must never mistake this for a
 * faithful account of Postgres or InnoDB.
 *
 * Lighter than it was (no slab fill, one quiet line) because the hero on `/`
 * now carries the "toy engine" framing in prose too — but still a full-width
 * persistent bar directly above the tool, which is the placement §12 asks for.
 */
export function DisclaimerBanner() {
  return (
    <p className="border-b border-edge bg-surface px-4 py-1.5 text-center text-label text-ink-dim">
      QueryLens runs a{' '}
      <strong className="font-medium text-ink">simplified educational model</strong> of database
      internals. Every number is true to <em>this</em> engine — not to Postgres, MySQL, or any
      production database.
    </p>
  );
}
