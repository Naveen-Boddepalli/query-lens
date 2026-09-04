import { Link } from 'react-router-dom';
import type { Stage } from '../engine/index.ts';
import { STAGES } from '../engine/index.ts';
import { STAGE_META } from '../ui/stageMeta.ts';

const STAGE_DESCRIPTIONS: Partial<Record<Stage, string>> = {
  parse: 'SQL text → tokens → abstract syntax tree. The first pass that turns your query into a structure the engine can reason about.',
  plan: 'AST → logical plan tree. Decides which operators to use and how to compose them.',
  optimize: 'Rule-based rewrites — predicate pushdown, join reordering — that turn a naïve plan into an efficient one.',
  execute: 'Volcano-style operators pulling rows one at a time. Each operator calls next() on the one below it.',
  buffer: 'A fixed pool of page-sized frames. Tracks hits, misses, and evictions — the bridge between operators and disk.',
  index: 'B+Tree traversal from root to leaf. Turns a key lookup into a page address without scanning the whole table.',
  lock: 'Coarse page-level locks that protect concurrent access. A simplified model of what real engines do at row granularity.',
  result: 'The final rows handed back to the client, after every operator has finished pulling.',
};

export function StagesIndex() {
  return (
    <div className="p-6">
      <h2 className="mb-2 text-heading font-semibold">Pipeline Stages</h2>
      <p className="mb-6 max-w-2xl text-body text-ink-dim">
        A SQL query passes through eight stages on its way from text to result rows.
        Each stage page shows an interactive demo and explains what that stage does.
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {STAGES.map((stageId) => {
          const meta = STAGE_META[stageId];
          return (
            <Link
              key={stageId}
              to={`/stages/${stageId}`}
              className="cell group rounded-lg border border-edge bg-surface-2 p-4 transition-colors hover:border-accent/50 hover:bg-surface-3"
            >
              <h3 className={`text-body font-semibold ${meta.tone} group-hover:text-ink`}>
                {meta.title}
              </h3>
              <p className="mt-1 text-label text-ink-dim">{meta.blurb}</p>
              {STAGE_DESCRIPTIONS[stageId] && (
                <p className="mt-2 text-label leading-relaxed text-ink-dim/80">
                  {STAGE_DESCRIPTIONS[stageId]}
                </p>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
