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
 * The eight stages as a connected progress rail.
 *
 * Redesigned from a row of text chips joined by "→" glyphs into a rail: each
 * stage is a node with a leading status dot, and the connector between two
 * nodes fills with the accent up to the stage the trace has reached, so the
 * shape itself reads as progress.
 *
 * Constraints kept from the old version: `aria-current="step"` on the live
 * stage, `aria-pressed` on the pin toggle, and — load-bearing for
 * `e2e/regressions.spec.ts` — the button's visible text is exactly
 * `STAGE_META[stage].title` and nothing else; the dot and connector are
 * `aria-hidden` decoration. Scrolls horizontally on a phone rather than
 * wrapping, so the rail never breaks across lines and never widens the page.
 */
export function PipelineTracker({ current, visited, selected, onSelect }: PipelineTrackerProps) {
  const currentIndex = current ? STAGES.indexOf(current) : -1;

  return (
    <nav
      aria-label="Query pipeline"
      className="-mx-1 flex items-center gap-1 overflow-x-auto px-1"
    >
      {STAGES.map((stage, i) => {
        const meta = STAGE_META[stage];
        const isCurrent = stage === current;
        const isVisited = visited.has(stage);
        const isBuilt = IMPLEMENTED_STAGES.includes(stage);
        const isPinned = stage === selected;
        // The connector leading into this node is "done" once the previous
        // stage has been reached.
        const connectorDone = i > 0 && (currentIndex >= i || visited.has(STAGES[i - 1]!));

        return (
          <div key={stage} className="flex shrink-0 items-center gap-1">
            {i > 0 && (
              <span
                aria-hidden
                className={[
                  'h-px w-3 shrink-0 rounded-full transition sm:w-5',
                  connectorDone ? 'bg-accent/70' : 'bg-edge',
                ].join(' ')}
              />
            )}
            <button
              type="button"
              onClick={() => { onSelect(stage); }}
              aria-current={isCurrent ? 'step' : undefined}
              aria-pressed={isPinned}
              title={
                isPinned
                  ? `${meta.title} is pinned — click to follow the trace again`
                  : isBuilt
                    ? meta.blurb
                    : `${meta.blurb} — not part of this release`
              }
              className={[
                'cell flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-label font-medium',
                isCurrent
                  ? 'border-accent bg-accent-soft text-ink shadow-glow'
                  : isVisited
                    ? `border-edge bg-surface-3 shadow-e1 hover:border-ink-dim/50 hover:bg-surface-4 active:bg-edge/60 ${meta.tone}`
                    : isBuilt
                      ? 'border-edge/60 bg-transparent text-ink-dim hover:border-ink-dim/50 hover:bg-surface-3 hover:text-ink active:bg-surface-4'
                      : 'border-dashed border-edge/50 bg-transparent text-ink-dim/80 hover:border-ink-dim/40 hover:bg-surface-3',
                isPinned ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : '',
              ].join(' ')}
            >
              <span
                aria-hidden
                className={[
                  'h-1.5 w-1.5 shrink-0 rounded-full transition',
                  isCurrent
                    ? 'bg-accent-strong shadow-[0_0_8px_var(--color-accent)]'
                    : isVisited
                      ? 'bg-current'
                      : isBuilt
                        ? 'border border-current bg-transparent'
                        : 'border border-dashed border-current bg-transparent',
                ].join(' ')}
              />
              {meta.title}
            </button>
          </div>
        );
      })}
    </nav>
  );
}
