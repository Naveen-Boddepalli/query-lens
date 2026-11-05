import { Link } from 'react-router-dom';
import { STAGES } from '../engine/index.ts';
import { STAGE_META } from '../ui/stageMeta.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnPrimary, btnSecondary, cardInteractive } from '../ui/primitives.ts';

export function StagesIndex() {
  return (
    <div className="mx-auto max-w-6xl p-6 sm:p-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <PageHeader title="Pipeline stages">
          A SQL query passes through eight stages on its way from text to result rows. Each stage
          page shows an interactive demo and explains what that stage does in the engine.
        </PageHeader>
        <div className="flex shrink-0 gap-2">
          <Link to="/stages/parse" className={btnPrimary}>
            Start at Stage 01
          </Link>
          <Link to="/playground" className={btnSecondary}>
            Open Playground
          </Link>
        </div>
      </div>


      {/* Stage Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STAGES.map((stageId, i) => {
          const meta = STAGE_META[stageId];
          return (
            <Link key={stageId} to={`/stages/${stageId}`} className={cardInteractive}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 rounded-sm"
                    style={{ background: `var(--color-stage-${stageId})` }}
                  />
                  <span aria-hidden className="font-mono text-label text-ink-dim/60">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                </div>
                <svg
                  aria-hidden="true"
                  className="h-3.5 w-3.5 text-ink-dim/40 transition group-hover:translate-x-0.5 group-hover:text-accent"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M6 3.5l4.5 4.5L6 12.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <h3 className={`mt-2 text-body font-semibold ${meta.tone} group-hover:text-ink`}>
                {meta.title}
              </h3>
              <p className="mt-1 text-label font-medium text-ink-dim">{meta.blurb}</p>
              <p className="mt-2 text-label leading-relaxed text-ink-dim">{meta.help}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
