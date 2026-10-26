import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { DataTable } from '../../ui/DataView.tsx';
import type { TableColumn } from '../../ui/DataView.tsx';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnSecondary, card, panelSurface } from '../../ui/primitives.ts';
import type { ChallengeOutcome, OutcomeTable } from './outcome.ts';

/**
 * The parts of a challenge page that are the same whether the player writes a script or sets a few numbers: the
 * breadcrumb, the brief and the hint; the verdict, the facts, the tables and the link into the tool; and the box that
 * says what the challenge was for once it is solved. The views that differ — a text box, a form — sit between them.
 */

export interface ChallengeHeaderProps {
  /** Zero-based place in the whole list of challenges, and how many there are. */
  index: number;
  total: number;
  title: string;
  brief: ReactNode;
  hint: ReactNode;
}

export function ChallengeHeader({ index, total, title, brief, hint }: ChallengeHeaderProps) {
  const [showHint, setShowHint] = useState(false);
  return (
    <>
      <p className="text-label text-ink-dim">
        <Link to="/challenges" className="underline underline-offset-2 hover:text-ink">
          Challenges
        </Link>
        {' · '}
        {index + 1} of {total}
      </p>
      <PageHeader title={title} className="mt-2">
        {brief}
      </PageHeader>

      <div className="mt-4">
        <button
          type="button"
          onClick={() => { setShowHint((v) => !v); }}
          aria-expanded={showHint}
          className="text-label text-ink-dim underline-offset-2 hover:text-ink hover:underline"
        >
          {showHint ? 'Hide hint' : 'Show hint'}
        </button>
        {showHint && (
          <p className="mt-1 rounded-lg border border-edge bg-surface-2 px-3 py-2 text-label text-ink-dim">{hint}</p>
        )}
      </div>
    </>
  );
}

function Table({ table }: { table: OutcomeTable }) {
  const columns: TableColumn<string[]>[] = table.columns.map((header, i) => ({ header, cell: (row) => row[i] }));
  return <DataTable caption={table.caption} columns={columns} rows={table.rows} keyOf={(_, i) => String(i)} />;
}

export function ChallengeOutcomeView({
  outcome,
  notYet,
}: {
  outcome: ChallengeOutcome | null;
  /** What to say beside a miss: the one thing worth reading next. */
  notYet: string;
}) {
  if (!outcome) return null;
  return (
    <div className="mt-4 space-y-3">
      {outcome.problem !== null ? (
        <p className="rounded-lg border border-evict/40 bg-evict/10 px-3 py-2 text-label text-evict" role="alert">
          {outcome.problem}
        </p>
      ) : (
        <>
          <div
            role="status"
            className={`rounded-xl border px-4 py-3 ${
              outcome.passed ? 'border-hit/50 bg-hit/10 text-ink' : 'border-edge bg-surface-2 text-ink-dim'
            }`}
          >
            {outcome.passed ? '✓ Solved.' : `Not there yet — ${notYet}`}
          </div>

          {outcome.facts.length > 0 && (
            <dl className={`flex flex-wrap gap-x-5 gap-y-1 ${panelSurface} p-3 text-label`}>
              {outcome.facts.map((f) => (
                <div key={f.label}>
                  <dt className="text-ink-dim">{f.label}</dt>
                  <dd className="font-mono text-ink">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {outcome.tables.map((t) => (
            <Table key={t.caption} table={t} />
          ))}

          {outcome.toolHref && (
            <Link to={outcome.toolHref} className={btnSecondary}>
              Open this run in its tool →
            </Link>
          )}
        </>
      )}
    </div>
  );
}

export function SolvedPanel({
  misconception,
  next,
}: {
  misconception: ReactNode;
  next: { id: string; title: string } | null;
}) {
  const link =
    'mt-1 inline-block text-label text-ink-dim underline-offset-2 hover:text-ink hover:underline';
  return (
    <div className={`mt-6 ${card}`}>
      <p className="text-body text-ink">Nice.</p>
      <p className="mt-2 text-label leading-relaxed text-ink-dim">
        <span className="text-ink">The belief this checks:</span> {misconception}
      </p>
      {next ? (
        <Link to={`/challenges/${next.id}`} className={link}>
          Next: {next.title} →
        </Link>
      ) : (
        <Link to="/challenges" className={link}>
          That is all of them — back to the list
        </Link>
      )}
    </div>
  );
}
