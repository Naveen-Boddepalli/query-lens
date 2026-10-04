import { createTraceProjector } from '../engine/index.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../engine/index.ts';
import type { RunResult } from '../engine/index.ts';

/** The numbers one run is judged by. Shared by `/compare`'s side-by-side columns and the Playground's trace diff. */
export interface Scorecard {
  steps: number;
  diskReads: number;
  hits: number;
  evictions: number;
  btreeReads: number;
  locks: number;
  rows: number;
  usedIndex: boolean;
}

export function scoreOf(result: RunResult): Scorecard {
  const end = createTraceProjector(result.events, DEFAULT_ENGINE_OPTIONS).at(result.events.length);
  return {
    steps: result.events.length,
    diskReads: end.bufferStats.misses,
    hits: end.bufferStats.hits,
    evictions: end.bufferStats.evictions,
    btreeReads: end.indexPath.length,
    locks: end.locksTaken,
    rows: result.rows.length,
    usedIndex: result.events.some((e) => e.stage === 'index'),
  };
}
