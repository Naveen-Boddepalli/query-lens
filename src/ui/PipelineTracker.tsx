import { IMPLEMENTED_STAGES, STAGES } from '../engine/index.ts';
import type { Stage } from '../engine/index.ts';
import { STAGE_META } from './stageMeta.ts';

export interface PipelineTrackerProps {
  current: Stage | null;
  visited: ReadonlySet<Stage>;
  selected: Stage | null;
  onSelect: (stage: Stage) => void;
}

export function PipelineTracker({ current, visited, selected, onSelect }: PipelineTrackerProps) {
  return (
    <nav aria-label="Query pipeline" className="flex flex-wrap items-center gap-1">
      {STAGES.map((stage, i) => {
        const meta = STAGE_META[stage];
        const isCurrent = stage === current;
        const isVisited = visited.has(stage);
        const isBuilt = IMPLEMENTED_STAGES.includes(stage);
        return (
          <div key={stage} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden className="text-ink-dim/80">→</span>}
            <button
              type="button"
              onClick={() => { onSelect(stage); }}
              aria-current={isCurrent ? 'step' : undefined}
              title={isBuilt ? meta.blurb : `${meta.blurb} — not built yet (${meta.milestone})`}
              className={[
                'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                isCurrent
                  ? 'border-accent bg-accent/15 text-ink'
                  : isVisited
                    ? `border-edge bg-surface-3 ${meta.tone}`
                    : isBuilt
                      ? 'border-edge/60 bg-transparent text-ink-dim'
                      : 'border-dashed border-edge/50 bg-transparent text-ink-dim/80',
                stage === selected ? 'ring-1 ring-accent/70' : '',
              ].join(' ')}
            >
              {meta.title}
            </button>
          </div>
        );
      })}
    </nav>
  );
}
