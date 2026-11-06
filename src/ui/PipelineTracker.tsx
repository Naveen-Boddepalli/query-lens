import { IMPLEMENTED_STAGES, STAGES } from '../engine/index.ts';
import type { Stage } from '../engine/index.ts';
import { STAGE_META } from './stageMeta.ts';

export interface PipelineTrackerProps {
  current: Stage | null;
  visited: ReadonlySet<Stage>;
  selected: Stage | null;
  onSelect: (stage: Stage) => void;
}

/**
 * The eight stages as a connected progress rail with Tactile Glass capsule styling.
 */
export function PipelineTracker({ current, visited, selected, onSelect }: PipelineTrackerProps) {
  const currentIndex = current ? STAGES.indexOf(current) : -1;

  return (
    <nav
      aria-label="Query pipeline"
      className="flex w-full min-w-0 max-w-full items-center gap-1 overflow-x-auto rounded-full border border-edge bg-surface-2/80 p-1 shadow-neu-rest backdrop-blur-md"
    >
      {STAGES.map((stage, i) => {
        const meta = STAGE_META[stage];
        const isCurrent = stage === current;
        const isVisited = visited.has(stage);
        const isBuilt = IMPLEMENTED_STAGES.includes(stage);
        const isPinned = stage === selected;
        const connectorDone = i > 0 && (currentIndex >= i || visited.has(STAGES[i - 1]!));

        return (
          <div key={stage} className="flex shrink-0 items-center gap-1">
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`h-0.5 w-3 shrink-0 rounded-full transition-colors sm:w-4 ${
                  connectorDone ? 'bg-accent/80 shadow-glow' : 'bg-edge'
                }`}
              />
            )}
            <button
              type="button"
              onClick={() => { onSelect(stage); }}
              aria-current={isCurrent ? 'step' : undefined}
              aria-pressed={isPinned}
              title={
                isPinned
                  ? `${meta.title} (pinned)`
                  : isBuilt
                    ? meta.blurb
                    : `${meta.blurb} — not part of this release`
              }
              className={`cell flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-label font-medium select-none transition-all ${
                isCurrent
                  ? 'border-accent bg-accent-soft text-ink shadow-glow'
                  : isVisited
                    ? `border-edge bg-surface-3 shadow-neu-rest hover:border-ink-dim/50 hover:text-ink active:scale-95 ${meta.tone}`
                    : isBuilt
                      ? 'border-edge/60 bg-transparent text-ink-dim hover:border-ink-dim/50 hover:text-ink active:scale-95'
                      : 'border-dashed border-edge/50 bg-transparent text-ink-dim/80 hover:border-ink-dim/40'
              }${isPinned ? ' ring-2 ring-accent ring-offset-2 ring-offset-surface' : ''}`}
            >
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 shrink-0 rounded-full transition-all ${
                  isCurrent
                    ? 'bg-accent-strong shadow-glow animate-pulse'
                    : isVisited
                      ? 'bg-current'
                      : `border border-current bg-transparent${isBuilt ? '' : ' border-dashed'}`
                }`}
              />
              {meta.title}
            </button>
          </div>
        );
      })}
    </nav>
  );
}
