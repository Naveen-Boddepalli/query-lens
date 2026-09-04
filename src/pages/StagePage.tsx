import { useMemo } from 'react';
import { useParams, Navigate, Link } from 'react-router-dom';
import {
  createSeedDatabase,
  createTraceProjector,
  DEFAULT_ENGINE_OPTIONS,
  runQuery,
  STAGES,
} from '../engine/index.ts';
import type { Stage } from '../engine/index.ts';
import { STAGE_META } from '../ui/stageMeta.ts';
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx';
import { StageDetail } from '../ui/panels/StageDetail.tsx';

const INITIAL_SQL = 'SELECT *\nFROM users\nWHERE id = 5;';

const STAGE_EDUCATION: Record<Stage, string> = {
  parse: 'The parser is the first stage of query processing. It takes raw SQL text, breaks it into tokens (keywords, identifiers, operators), and assembles them into an Abstract Syntax Tree (AST). The AST is a structured representation that the rest of the engine can work with — no more string manipulation from here on.',
  plan: 'The planner turns the AST into a logical plan — a tree of relational operators like Scan, Filter, and Project. Each operator describes *what* to compute, not *how*. The planner decides which operators are needed based on the clauses in your query.',
  optimize: 'The optimizer applies rewrite rules to the logical plan to make it faster. Predicate pushdown moves filters closer to the data source. In a real engine, the optimizer also considers join order, index selection, and cost estimates — here we show the rule-based rewrites.',
  execute: 'Execution uses the Volcano (iterator) model: each operator implements a next() method that pulls one row at a time from the operator below it. A row travels all the way from the leaf (scan) to the root (result) before the next row is fetched. This is pull-based, demand-driven execution.',
  buffer: 'The buffer pool is a fixed-size cache of disk pages held in memory. When an operator needs a page, it asks the buffer pool. A hit means the page is already in memory; a miss means it must be read from disk. When the pool is full, an eviction policy (LRU or Clock) chooses which page to discard.',
  index: 'The B+Tree index maps key values to row locations (page + slot). A point lookup starts at the root, follows child pointers at each internal node by comparing keys, and arrives at a leaf that contains the actual row pointer. This turns an O(n) scan into an O(log n) traversal.',
  lock: 'Locks protect pages from concurrent access. Before reading or writing a page, the engine acquires a shared or exclusive lock. This simplified model shows page-level locking — real engines often lock at row granularity and use sophisticated deadlock detection.',
  result: 'The result stage collects the rows produced by the execution tree and hands them back to the client. In a real database, this is where result formatting, pagination, and client protocol encoding happen.',
};

function isValidStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}

export function StagePage() {
  const { stageId } = useParams<{ stageId: string }>();

  // Run a default query to produce a demo state for this stage.
  const demoState = useMemo(() => {
    if (!stageId || !isValidStage(stageId)) return null;
    const db = createSeedDatabase();
    const result = runQuery(INITIAL_SQL, db, DEFAULT_ENGINE_OPTIONS);
    const projector = createTraceProjector(result.events, DEFAULT_ENGINE_OPTIONS);
    // Find the last event for this stage to show its final state.
    let lastStep = 0;
    for (let i = 0; i < result.events.length; i++) {
      if (result.events[i]?.stage === stageId) lastStep = i + 1;
    }
    return projector.at(lastStep || result.events.length);
  }, [stageId]);

  if (!stageId || !isValidStage(stageId) || !demoState) {
    return <Navigate to="/stages" replace />;
  }

  const meta = STAGE_META[stageId];
  const stageIndex = STAGES.indexOf(stageId);
  const prevStage = stageIndex > 0 ? STAGES[stageIndex - 1] : null;
  const nextStage = stageIndex < STAGES.length - 1 ? STAGES[stageIndex + 1] : null;

  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
      <div>
        <h2 className={`text-heading font-semibold ${meta.tone}`}>{meta.title}</h2>
        <p className="mt-1 text-body text-ink-dim">{meta.blurb}</p>
      </div>

      <div className="max-w-3xl text-body leading-relaxed text-ink-dim">
        <p>{STAGE_EDUCATION[stageId]}</p>
      </div>

      {/* Interactive demo panel */}
      <div className="min-h-80 overflow-hidden rounded-lg border border-edge bg-surface-2 p-4">
        <ErrorBoundary variant="panel" label={meta.title} resetKey={stageId}>
          <StageDetail
            stage={stageId}
            state={demoState}
            policy={DEFAULT_ENGINE_OPTIONS.policy}
            pinned={false}
          />
        </ErrorBoundary>
      </div>

      {/* Previous / Next navigation */}
      <nav className="flex items-center justify-between border-t border-edge pt-4">
        {prevStage ? (
          <Link
            to={`/stages/${prevStage}`}
            className="rounded-md border border-edge px-3 py-1.5 text-label text-ink-dim transition-colors hover:border-accent/70 hover:text-ink"
          >
            ← {STAGE_META[prevStage].title}
          </Link>
        ) : (
          <span />
        )}
        {nextStage ? (
          <Link
            to={`/stages/${nextStage}`}
            className="rounded-md border border-edge px-3 py-1.5 text-label text-ink-dim transition-colors hover:border-accent/70 hover:text-ink"
          >
            {STAGE_META[nextStage].title} →
          </Link>
        ) : (
          <Link
            to="/"
            className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-label font-medium text-ink transition-colors hover:bg-accent/25"
          >
            Try it in the Playground →
          </Link>
        )}
      </nav>
    </div>
  );
}
