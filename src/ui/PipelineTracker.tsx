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
              // The pin is a toggle, and a screen reader should hear which one
              // is held rather than only seeing a ring.
              aria-pressed={stage === selected}
              title={
                stage === selected
                  ? `${meta.title} is pinned — click to follow the trace again`
                  : isBuilt
                    ? meta.blurb
                    : `${meta.blurb} — not part of this release`
              }
              className={[
                /* plan.md §16.2 item 4. These chips are the one set of diagram
                   elements that genuinely *are* controls — clicking pins the
                   panel to a stage — so they are the one set with an `active:`
                   press state, which the read-only cells have no business
                   having. They are also buttons, so index.css's cursor rule
                   already gives them the pointer that tells a visitor the
                   tracker is not another diagram. */
                'cell rounded-md border px-2.5 py-1 text-label font-medium',
                isCurrent
                  ? 'border-accent bg-accent/15 text-ink hover:bg-accent/25 active:bg-accent/35'
                  : isVisited
                    ? `border-edge bg-surface-3 hover:border-ink-dim/50 hover:bg-surface-4 active:bg-edge/60 ${meta.tone}`
                    : isBuilt
                      ? 'border-edge/60 bg-transparent text-ink-dim hover:border-ink-dim/50 hover:bg-surface-3 hover:text-ink active:bg-surface-4'
                      : 'border-dashed border-edge/50 bg-transparent text-ink-dim/80 hover:border-ink-dim/40 hover:bg-surface-3',
                // Was `ring-1 ring-accent/70`, which is invisible next to a
                // chip that already has a coloured border — and this state
                // stops the panel following the trace, so it has to read.
                stage === selected ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : '',
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
