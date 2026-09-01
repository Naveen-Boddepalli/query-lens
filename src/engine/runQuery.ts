/**
 * The engine entry point, and the whole of the engine's public surface.
 *
 *   pure · synchronous · no DOM · no React · fully serializable output
 *
 * Kept worker-ready on purpose (plan.md §5) but deliberately run on the main
 * thread in v0: step-back needs the full event history regardless, so once the
 * UI holds the whole array a worker boundary buys nothing.
 */

import { buildPlaceholderTrace } from './placeholderTrace.ts';
import { DEFAULT_ENGINE_OPTIONS } from './types.ts';
import type { Database, EngineOptions, RunResult } from './types.ts';

export function runQuery(
  _sql: string,
  _db: Database,
  _options: EngineOptions = DEFAULT_ENGINE_OPTIONS,
): RunResult {
  // M0: no parser, no planner, no executor yet — hand back the canned trace so
  // the playback architecture can be exercised end to end. M1 replaces this
  // with a real tokenizer + recursive-descent parse of `_sql`.
  return buildPlaceholderTrace();
}
