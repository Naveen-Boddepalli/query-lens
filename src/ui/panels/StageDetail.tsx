import type { ReplacementPolicyName, Stage, ViewState } from '../../engine/index.ts';
import { STAGE_META } from '../stageMeta.ts';
import { BufferPoolPanel } from './BufferPoolPanel.tsx';
import { ResultPanel } from './ResultPanel.tsx';
import { TreePanel } from './TreePanel.tsx';

export interface StageDetailProps {
  stage: Stage;
  state: ViewState;
  policy: ReplacementPolicyName;
}

function Placeholder({ what, milestone }: { what: string; milestone: string }) {
  return (
    <p className="text-sm text-ink-dim">
      {what} <span className="text-ink-dim/70">Arrives in {milestone}.</span>
    </p>
  );
}

export function StageDetail({ stage, state, policy }: StageDetailProps) {
  const meta = STAGE_META[stage];

  return (
    <section className="flex h-full flex-col gap-3">
      <header>
        <h2 className={`text-sm font-semibold ${meta.tone}`}>{meta.title}</h2>
        <p className="text-xs text-ink-dim">{meta.blurb}</p>
      </header>

      <div className="flex-1">
        {stage === 'parse' && (
          <TreePanel root={state.ast} empty="No AST yet — the parser has not run." />
        )}

        {stage === 'plan' && (
          <TreePanel root={state.plan} empty="No plan yet." />
        )}

        {stage === 'optimize' &&
          (state.planBefore ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="mb-2 text-xs text-ink-dim">before</h3>
                <TreePanel root={state.planBefore} empty="—" />
              </div>
              <div>
                <h3 className="mb-2 text-xs text-ink-dim">
                  after · {state.appliedRules.join(', ')}
                </h3>
                <TreePanel root={state.plan} empty="—" />
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink-dim">No rewrite applied yet.</p>
          ))}

        {stage === 'execute' &&
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

        {stage === 'buffer' && (
          <BufferPoolPanel
            frames={state.frames}
            stats={state.bufferStats}
            clockHand={state.clockHand}
            policy={policy}
            lastEvent={state.lastEvent}
          />
        )}

        {stage === 'index' &&
          (state.indexPath.length === 0 ? (
            <Placeholder what="The B+Tree has not been traversed yet." milestone="M4" />
          ) : (
            <div className="space-y-2">
              <p className="font-mono text-xs">
                {state.indexPath.join(' → ')}{' '}
                {state.indexOutcome === 'found' && <span className="text-hit">✓ found</span>}
                {state.indexOutcome === 'not-found' && <span className="text-evict">✗ not found</span>}
              </p>
              <Placeholder what="Node-and-pointer diagram pending." milestone="M4" />
            </div>
          ))}

        {stage === 'lock' &&
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

        {stage === 'result' && <ResultPanel rows={state.rows} />}
      </div>
    </section>
  );
}
