import { Link } from 'react-router-dom';
import { STAGES } from '../engine/index.ts';
import { STAGE_META } from '../ui/stageMeta.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { cardInteractive } from '../ui/primitives.ts';

export function StagesIndex() {
  return (
    <div className="p-6 sm:p-8">
      <PageHeader title="Pipeline stages">
        A SQL query passes through eight stages on its way from text to result rows. Each stage
        page shows an interactive demo and explains what that stage does.
      </PageHeader>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {STAGES.map((stageId, i) => {
          const meta = STAGE_META[stageId];
          return (
            <Link key={stageId} to={`/stages/${stageId}`} className={cardInteractive}>
              <div className="flex items-baseline gap-2">
                <span aria-hidden className="font-mono text-label text-ink-dim/60">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className={`text-body font-semibold ${meta.tone} group-hover:text-ink`}>
                  {meta.title}
                </h3>
              </div>
              <p className="mt-1 text-label text-ink-dim">{meta.blurb}</p>
              <p className="mt-2 text-label leading-relaxed text-ink-dim/80">{meta.help}</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
