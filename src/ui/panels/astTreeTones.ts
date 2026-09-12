/**
 * Colour by syntactic category, so shape and colour reinforce each other.
 *
 * The `hover:` half is plan.md §16.2 item 4's tinted rule: fill one step
 * deeper, border one step brighter, in the node's own hue rather than a shared
 * neutral. A `Where` that turned grey on hover would be saying something false
 * about itself for as long as the cursor sat on it.
 *
 * Its own file, not `AstTree.tsx` — Fast Refresh only works on a file that
 * exports nothing but components, and `renderSvg`'s SVG export (§20.3) reuses
 * this exact map (`StageDetail.tsx`) rather than duplicating a second colour
 * table that could drift from what's actually on screen.
 */
export const TONES: Record<string, string> = {
  SelectStatement:
    'border-hue-sky/70 bg-hue-sky/10 text-hue-sky-ink hover:border-hue-sky hover:bg-hue-sky/20',
  DeleteStatement:
    'border-hue-sky/70 bg-hue-sky/10 text-hue-sky-ink hover:border-hue-sky hover:bg-hue-sky/20',
  InsertStatement:
    'border-hue-sky/70 bg-hue-sky/10 text-hue-sky-ink hover:border-hue-sky hover:bg-hue-sky/20',
  UpdateStatement:
    'border-hue-sky/70 bg-hue-sky/10 text-hue-sky-ink hover:border-hue-sky hover:bg-hue-sky/20',
  SelectList:
    'border-hue-sky/50 bg-hue-sky/5 text-hue-sky-ink hover:border-hue-sky/80 hover:bg-hue-sky/15',
  // INSERT's own two lists, and UPDATE's SET — same tone family as SelectList, the thing they mirror.
  ColumnList:
    'border-hue-sky/50 bg-hue-sky/5 text-hue-sky-ink hover:border-hue-sky/80 hover:bg-hue-sky/15',
  Values:
    'border-hue-sky/50 bg-hue-sky/5 text-hue-sky-ink hover:border-hue-sky/80 hover:bg-hue-sky/15',
  Set: 'border-hue-sky/50 bg-hue-sky/5 text-hue-sky-ink hover:border-hue-sky/80 hover:bg-hue-sky/15',
  // Shares Compare's tone — an assignment is a column paired with a value, same as a predicate.
  Assignment:
    'border-hue-amber/50 bg-hue-amber/5 text-hue-amber-ink hover:border-hue-amber/80 hover:bg-hue-amber/15',
  From: 'border-hue-violet/60 bg-hue-violet/10 text-hue-violet-ink hover:border-hue-violet/90 hover:bg-hue-violet/20',
  // Shares From's tone — INTO names the same kind of thing, just for a write.
  Into: 'border-hue-violet/60 bg-hue-violet/10 text-hue-violet-ink hover:border-hue-violet/90 hover:bg-hue-violet/20',
  Where:
    'border-hue-amber/60 bg-hue-amber/10 text-hue-amber-ink hover:border-hue-amber/90 hover:bg-hue-amber/20',
  And: 'border-hue-amber/50 bg-hue-amber/5 text-hue-amber-ink hover:border-hue-amber/80 hover:bg-hue-amber/15',
  Compare:
    'border-hue-amber/50 bg-hue-amber/5 text-hue-amber-ink hover:border-hue-amber/80 hover:bg-hue-amber/15',
  Column:
    'border-hue-emerald/50 bg-hue-emerald/5 text-hue-emerald-ink hover:border-hue-emerald/80 hover:bg-hue-emerald/15',
  Table:
    'border-hue-violet/50 bg-hue-violet/5 text-hue-violet-ink hover:border-hue-violet/80 hover:bg-hue-violet/15',
  Literal: 'border-edge bg-surface-3 text-ink hover:border-ink-dim/50 hover:bg-surface-4',
  Star: 'border-edge bg-surface-3 text-ink hover:border-ink-dim/50 hover:bg-surface-4',
  Limit:
    'border-hue-orange/60 bg-hue-orange/10 text-hue-orange-ink hover:border-hue-orange/90 hover:bg-hue-orange/20',
  // Shares Limit's tone — a computed value, same family as a capped result.
  Aggregate:
    'border-hue-orange/60 bg-hue-orange/10 text-hue-orange-ink hover:border-hue-orange/90 hover:bg-hue-orange/20',
  // Shares Column's tone — an ORDER BY or GROUP BY clause is fundamentally naming one.
  OrderBy:
    'border-hue-emerald/60 bg-hue-emerald/10 text-hue-emerald-ink hover:border-hue-emerald/90 hover:bg-hue-emerald/20',
  GroupBy:
    'border-hue-emerald/60 bg-hue-emerald/10 text-hue-emerald-ink hover:border-hue-emerald/90 hover:bg-hue-emerald/20',
};
