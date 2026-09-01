import { IMPLEMENTED_STAGES } from '../../engine/index.ts';
import type { ReplacementPolicyName, Span, Stage, ViewState } from '../../engine/index.ts';
import { STAGE_META } from '../stageMeta.ts';
import { AstTree } from './AstTree.tsx';
import { BufferPoolPanel } from './BufferPoolPanel.tsx';
import { ResultPanel } from './ResultPanel.tsx';
import { PlanTree } from './PlanTree.tsx';

export interface StageDetailProps {
  stage: Stage;
  state: ViewState;
  policy: ReplacementPolicyName;
  activeSpan?: Span | undefined;
}

/**
 * Shown for stages the engine does not implement yet. Being explicit about
 * this is not an apology — a pipeline that looks complete when it is not would
 * teach the wrong thing (plan.md §2).
 */
function NotBuiltYet({ stage }: { stage: Stage }) {
  const meta = STAGE_META[stage];
  return (
    <div className="flex h-full flex-col items-start justify-center gap-1.5 text-sm">
      <p className="text-ink-dim">
        The <span className="text-ink">{meta.title.toLowerCase()}</span> is not built yet.
      </p>
      <p className="text-xs text-ink-dim/80">
        {meta.blurb}. Arrives in <span className="font-mono">{meta.milestone}</span>.
      </p>
    </div>
  );
}

export function StageDetail({ stage, state, policy, activeSpan }: StageDetailProps) {
  const meta = STAGE_META[stage];
  const implemented = IMPLEMENTED_STAGES.includes(stage);

  return (
    <section className="flex h-full flex-col gap-3">
      <header>
        <h2 className={`text-sm font-semibold ${meta.tone}`}>{meta.title}</h2>
        <p className="text-xs text-ink-dim">{meta.blurb}</p>
      </header>

      <div className="min-h-0 flex-1">
        {!implemented && <NotBuiltYet stage={stage} />}

        {implemented && stage === 'parse' && (
          <AstTree root={state.ast} highlight={activeSpan} />
        )}

        {implemented && stage === 'plan' && (
          <PlanTree root={state.plan} empty="No plan yet — the planner has not run." />
        )}

        {implemented && stage === 'optimize' &&
          (state.planBefore ? (
            <div className="grid h-full grid-rows-[auto_1fr] gap-2 sm:grid-cols-2 sm:grid-rows-1">
              <div className="grid h-full min-h-0 grid-rows-[auto_1fr]">
                <h3 className="mb-1 text-xs text-ink-dim">before</h3>
                <PlanTree root={state.planBefore} empty="—" />
              </div>
              <div className="grid h-full min-h-0 grid-rows-[auto_1fr] border-edge sm:border-l sm:pl-3">
                <h3 className="mb-1 text-xs text-ink-dim">
                  after ·{' '}
                  <span className="font-mono text-accent">
                    {state.appliedRules[state.appliedRules.length - 1]}
                  </span>
                </h3>
                <PlanTree root={state.plan} empty="—" />
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink-dim">No rewrite applied yet.</p>
          ))}

        {implemented && stage === 'execute' &&
          (state.operators.length === 0 ? (
            <p className="text-sm text-ink-dim">No operator has produced rows yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {state.operators.map((op) => (
                <li
                  key={op.op}
                  className="flex items-baseline justify-between rounded-md border border-edge bg-surface-3 px-2.5 py-1.5 font-mono text-xs"
                >
                  <span>{op.op}</span>
                  <span className="text-ink-dim">{op.rowsProduced} rows</span>
                </li>
              ))}
            </ul>
          ))}

        {implemented && stage === 'buffer' && (
          <BufferPoolPanel
            frames={state.frames}
            stats={state.bufferStats}
            clockHand={state.clockHand}
            policy={policy}
            lastEvent={state.lastEvent}
          />
        )}

        {implemented && stage === 'index' &&
          (state.indexPath.length === 0 ? (
            <p className="text-sm text-ink-dim">The B+Tree has not been traversed yet.</p>
          ) : (
            <p className="font-mono text-xs">
              {state.indexPath.join(' → ')}{' '}
              {state.indexOutcome === 'found' && <span className="text-hit">✓ found</span>}
              {state.indexOutcome === 'not-found' && <span className="text-evict">✗ not found</span>}
            </p>
          ))}

        {implemented && stage === 'lock' &&
          (state.locks.length === 0 ? (
            <p className="text-sm text-ink-dim">No locks held.</p>
          ) : (
            <ul className="space-y-1.5">
              {state.locks.map((l) => (
                <li
                  key={`${l.pageId}-${l.mode}`}
                  className="rounded-md border border-edge bg-surface-3 px-2.5 py-1.5 font-mono text-xs"
                >
                  🔒 page {l.pageId} · {l.mode}
                </li>
              ))}
            </ul>
          ))}

        {implemented && stage === 'result' && <ResultPanel rows={state.rows} />}
      </div>
    </section>
  );
}
