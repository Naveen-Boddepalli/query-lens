import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { IMPLEMENTED_STAGES } from '../../engine/index.ts';
import type { ReplacementPolicyName, Span, Stage, ViewState } from '../../engine/index.ts';
import {
  astToMermaid,
  astToText,
  explainToText,
  indexTreeToText,
  planToLatex,
  planToMermaid,
  planToRelationalAlgebra,
  planToText,
} from '../../export/index.ts';
import { STAGE_META } from '../stageMeta.ts';
import { CopyButton } from '../CopyButton.tsx';
import { DownloadPngButton } from '../DownloadPngButton.tsx';
import { DownloadSvgButton, type DownloadSvgButtonProps } from '../DownloadSvgButton.tsx';
import type { SideEdge } from './FlowTree.tsx';
import { AstTree } from './AstTree.tsx';
import { TONES as AST_TONES } from './astTreeTones.ts';
import { BTreePanel } from './BTreePanel.tsx';
import {
  collectSiblings,
  ICONS as BTREE_ICONS,
  toFlow as btreeToFlow,
  TONES as BTREE_TONES,
} from './btreeTones.ts';
import { LockPanel } from './LockPanel.tsx';
import { BufferPoolPanel } from './BufferPoolPanel.tsx';
import { ResultPanel } from './ResultPanel.tsx';
import { PlanTree } from './PlanTree.tsx';
import { toFlow as planToFlow, TONES as PLAN_TONES } from './planTreeTones.ts';
import type { PlanNotation } from './planTreeTones.ts';

export interface StageDetailProps {
  stage: Stage;
  state: ViewState;
  policy: ReplacementPolicyName;
  activeSpan?: Span | undefined;
  /** True when this panel is held on a stage the trace has already left. */
  pinned?: boolean;
  /** Clears the pin, so the panel follows the trace again. */
  onFollow?: (() => void) | undefined;
  /**
   * Show the `?` "what am I looking at?" affordance next to the title (plan.md
   * §19.2). The Playground passes it; `/stages/:id` and the presenter view do
   * not — one is already the explainer, the other is a room-facing projection.
   */
  withHelp?: boolean;
}

/**
 * The fallback for a stage the engine does not implement.
 *
 * Every stage in the pipeline is implemented today, so nothing renders this —
 * but `STAGES` and `IMPLEMENTED_STAGES` are separate lists precisely so a new
 * stage can be declared before it works, and plan.md §2 is clear that a
 * pipeline which *looks* complete when it is not would teach the wrong thing.
 * The guard stays; what has gone is the release vocabulary it used to print.
 * "Arrives in M4" is a sentence about our backlog, not about databases, and a
 * visitor has no way to know what M4 is.
 */
function NotBuiltYet({ stage }: { stage: Stage }) {
  const meta = STAGE_META[stage];
  return (
    <div className="flex h-full flex-col items-start justify-center gap-1.5 text-body">
      <p className="text-ink-dim">
        The <span className="text-ink">{meta.title.toLowerCase()}</span> is not part of this
        release.
      </p>
      <p className="text-label text-ink-dim/80">{meta.blurb}.</p>
    </div>
  );
}

export function StageDetail({
  stage,
  state,
  policy,
  activeSpan,
  pinned = false,
  onFollow,
  withHelp = false,
}: StageDetailProps) {
  const meta = STAGE_META[stage];
  const implemented = IMPLEMENTED_STAGES.includes(stage);
  const panelRef = useRef<HTMLDivElement>(null);

  // Tracked as "help open for which stage" rather than a bare boolean, so
  // stepping to another stage closes it without an effect reaching for setState.
  const [helpFor, setHelpFor] = useState<Stage | null>(null);
  const helpOpen = withHelp && helpFor === stage;
  const helpId = useId();

  // plan.md §25.4 B5: the plan written by its physical operators, or by what it computes in relational algebra.
  // Remembered across steps within the panel; the colours follow the operator either way.
  const [notation, setNotation] = useState<PlanNotation>('operators');
  const isPlanStage = stage === 'plan' || stage === 'optimize';

  // Copy-as-Mermaid is offered on the two trees people actually paste (§20.3):
  // the AST and the plan. Not the B+Tree — Mermaid draws its sibling chain badly.
  const mermaid =
    stage === 'parse' && state.ast
      ? astToMermaid(state.ast)
      : (stage === 'plan' || stage === 'optimize') && state.plan
        ? planToMermaid(state.plan)
        : null;

  // Copy-as-text (§22.5) is the plain-monospace twin, and it *can* take the
  // B+Tree — a `tree(1)` list renders a sibling chain fine where Mermaid can't.
  const plainText =
    stage === 'parse' && state.ast
      ? astToText(state.ast)
      : (stage === 'plan' || stage === 'optimize') && state.plan
        ? planToText(state.plan)
        : stage === 'index' && state.indexTree
          ? indexTreeToText(state.indexTree)
          : null;

  // A real vector export (§20.3) — unlike Mermaid, it *can* take the B+Tree
  // (its own renderer draws a sibling chain fine; Mermaid's layout cannot).
  // `svgTree` bundles exactly what `renderSvg` needs: the same `FlowNode`
  // root, tone map and layout flags (`wide`/`compact`/`sideEdges`) each panel
  // already builds for itself, reused here rather than duplicated.
  const svgTree: Omit<DownloadSvgButtonProps, 'name'> | null =
    stage === 'parse' && state.ast
      ? { root: state.ast, tones: AST_TONES }
      : (stage === 'plan' || stage === 'optimize') && state.plan
        ? { root: planToFlow(state.plan, notation), tones: PLAN_TONES, wide: true }
        : stage === 'index' && state.indexTree
          ? (() => {
              const pathSet = new Set(state.indexPath);
              const sideEdges: SideEdge[] = [];
              collectSiblings(state.indexTree, sideEdges);
              return {
                root: btreeToFlow(state.indexTree, pathSet),
                tones: BTREE_TONES,
                kindIcons: BTREE_ICONS,
                compact: true,
                sideEdges,
              };
            })()
          : null;

  // The plan as relational algebra (plan.md §25.4 B5), for a homework answer or a lecture slide.
  const algebraText = isPlanStage && state.plan ? planToRelationalAlgebra(state.plan) : null;
  const latexText = isPlanStage && state.plan ? planToLatex(state.plan) : null;

  // In-app EXPLAIN (§22.2): estimate next to actual, offered once the query
  // has actually run — `state.operators` is only complete by the result
  // stage, the same way real `EXPLAIN ANALYZE` needs the query to finish.
  const explainText =
    stage === 'result' && state.plan
      ? explainToText(
          state.plan,
          new Map(state.operators.map((o) => [o.op, o.rowsProduced])),
        )
      : null;

  return (
    <section className="flex h-full flex-col gap-3">
      <header className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div>
          <div className="flex items-center gap-2">
            <h2 className={`text-heading font-semibold ${meta.tone}`}>{meta.title}</h2>
            {withHelp && (
              <button
                type="button"
                onClick={() => { setHelpFor((s) => (s === stage ? null : stage)); }}
                aria-expanded={helpOpen}
                aria-controls={helpId}
                className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-edge text-label leading-none text-ink-dim transition hover:border-ink-dim/50 hover:text-ink"
              >
                <span aria-hidden>?</span>
                <span className="sr-only">What is the {meta.title} panel?</span>
              </button>
            )}
          </div>
          <p className="text-label text-ink-dim">{meta.blurb}</p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {implemented && <DownloadPngButton target={panelRef} name={stage} />}
          {svgTree && <DownloadSvgButton name={stage} {...svgTree} />}
          {mermaid && (
            <CopyButton
              text={mermaid}
              label="Copy as Mermaid"
              title="Copy tree as Mermaid flowchart"
            />
          )}
          {plainText && (
            <CopyButton
              text={plainText}
              label="Copy as text"
              title="Copy tree as text"
            />
          )}
          {algebraText && (
            <CopyButton
              text={algebraText}
              label="Copy as relational algebra"
              title="Copy this plan as a relational-algebra expression — π, σ, ⋈, γ — for a proof or a lecture slide"
            />
          )}
          {latexText && (
            <CopyButton
              text={latexText}
              label="Copy as LaTeX"
              title="Copy the relational-algebra expression as LaTeX math"
            />
          )}
          {explainText && (
            <CopyButton
              text={explainText}
              label="Copy as EXPLAIN"
              title="Copy plan with operator row estimates"
            />
          )}

          {/* Selecting a stage holds the panel there while the trace runs on,
              which is the point — you can watch the buffer pool while execute
              events stream past. But held silently it reads as a bug: step
              with the arrows and nothing moves. So say so, and make leaving
              one click. */}
          {pinned && onFollow && (
            <button
              type="button"
              onClick={onFollow}
              className="rounded-full border border-accent/70 bg-accent-soft px-3 py-1 text-label text-ink shadow-e1 transition hover:bg-accent/20"
            >
              Pinned to {meta.title} — follow the trace
            </button>
          )}
        </div>
      </header>

      {helpOpen && (
        <div
          id={helpId}
          className="rounded-lg border border-edge bg-surface-2 px-3 py-2 text-label leading-relaxed text-ink-dim"
        >
          <p>{meta.help}</p>
          <Link
            to={meta.doc}
            className="mt-1.5 inline-block font-medium text-ink underline underline-offset-2 hover:no-underline"
          >
            Read the full explanation →
          </Link>
        </div>
      )}

      {isPlanStage && implemented && (
        <div role="group" aria-label="Plan notation" className="flex flex-wrap items-center gap-2 text-label text-ink-dim">
          <span>Show as</span>
          {(
            [
              ['operators', 'Operators', 'Filter, SeqScan, IndexScan — how the engine runs it'],
              ['algebra', 'Relational algebra', 'σ π ⋈ γ — what the plan computes'],
            ] as const
          ).map(([value, text, hint]) => (
            <button
              key={value}
              type="button"
              aria-pressed={notation === value}
              title={hint}
              onClick={() => { setNotation(value); }}
              className={
                notation === value
                  ? 'rounded-full border border-accent bg-accent-soft px-2.5 py-0.5 text-ink shadow-e1'
                  : 'rounded-full border border-edge px-2.5 py-0.5 transition hover:border-ink-dim/50 hover:text-ink'
              }
            >
              {text}
            </button>
          ))}
        </div>
      )}

      <div ref={panelRef} className="min-h-0 min-w-0 flex-1">
        {!implemented && <NotBuiltYet stage={stage} />}

        {implemented && stage === 'parse' && (
          <AstTree root={state.ast} highlight={activeSpan} />
        )}

        {implemented && stage === 'plan' && (
          <PlanTree root={state.plan} empty="No plan yet — the planner has not run." notation={notation} />
        )}

        {implemented && stage === 'optimize' &&
          (state.planBefore ? (
            <div className="grid h-full grid-rows-[auto_1fr] gap-2 sm:grid-cols-2 sm:grid-rows-1">
              <div className="grid h-full min-h-0 grid-rows-[auto_1fr]">
                <h3 className="mb-1 text-label text-ink-dim">before</h3>
                <PlanTree root={state.planBefore} empty="—" notation={notation} />
              </div>
              <div className="grid h-full min-h-0 grid-rows-[auto_1fr] border-edge sm:border-l sm:pl-3">
                <h3 className="mb-1 text-label text-ink-dim">
                  after ·{' '}
                  <span className="font-mono text-accent">
                    {state.appliedRules[state.appliedRules.length - 1]}
                  </span>
                </h3>
                <PlanTree root={state.plan} empty="—" notation={notation} />
              </div>
            </div>
          ) : (
            <p className="text-body text-ink-dim">No rewrite applied yet.</p>
          ))}

        {implemented && stage === 'execute' &&
          (state.operators.length === 0 ? (
            <p className="text-body text-ink-dim">No operator has produced rows yet.</p>
          ) : (
            <div className="space-y-3">
              {/* Listed root-last: rows are pulled from the top down and travel
                  back up, so reading bottom-to-top follows a single row. */}
              <div className="relative pl-4 space-y-1.5 border-l border-dashed border-edge">
                {[...state.operators].reverse().map((op) => {
                  const active =
                    state.lastEvent?.stage === 'execute' && state.lastEvent.op === op.op;
                  return (
                    <div
                      key={op.op}
                      className={`cell ql-sheen relative flex items-center justify-between rounded-lg border px-2.5 py-1.5 font-mono text-label shadow-e1 ${active ? 'border-accent bg-accent/15 text-ink shadow-glow font-medium' : 'border-edge bg-surface-3 text-ink-dim'}`}
                    >
                      <span
                        className={`absolute -left-[21px] h-2 w-2 rounded-full border border-surface ${active ? 'bg-accent' : 'bg-edge'}`}
                      />
                      <span>{op.op}</span>
                      <span className={active ? 'text-accent' : ''}>
                        {op.rowsProduced} row{op.rowsProduced === 1 ? '' : 's'}
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="text-label leading-relaxed text-ink-dim">
                Volcano model: each operator pulls one row at a time from the one below
                it. Nothing materialises the whole table — a row travels all the way to
                the top before the next is fetched.
              </p>
            </div>
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

        {implemented && stage === 'index' && (
          <BTreePanel
            tree={state.indexTree}
            path={state.indexPath}
            outcome={state.indexOutcome}
          />
        )}

        {implemented && stage === 'lock' && (
          <LockPanel locks={state.locks} taken={state.locksTaken} />
        )}

        {implemented && stage === 'result' && <ResultPanel rows={state.rows} />}
      </div>
    </section>
  );
}
