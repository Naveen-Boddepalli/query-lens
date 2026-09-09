import type { Stage } from '../engine/index.ts';

/**
 * plan.md §22.4: a little of what the visitor has done, for the `/progress`
 * dashboard that feeds the second visit (§21.2). Same discipline as
 * `learnProgress.ts` / `preferences.ts` / `theme.ts` — a *convenience*, never
 * state anything depends on: private mode or blocked site data degrades to
 * "nothing tracked", never throws. Per-browser, never leaves it.
 */

const KEY = 'querylens:progress';

export interface Progress {
  /** Pipeline stages the visitor has seen in a trace at least once. */
  stages: Stage[];
  /** Predictions committed to (a skip does not count). */
  asked: number;
  /** ...of which correct. */
  right: number;
}

const EMPTY: Progress = { stages: [], asked: 0, right: 0 };

export function readProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const p = JSON.parse(raw) as Record<string, unknown>;
    return {
      stages: Array.isArray(p.stages)
        ? p.stages.filter((s): s is Stage => typeof s === 'string')
        : [],
      asked: typeof p.asked === 'number' && p.asked >= 0 ? Math.floor(p.asked) : 0,
      right: typeof p.right === 'number' && p.right >= 0 ? Math.floor(p.right) : 0,
    };
  } catch {
    return EMPTY;
  }
}

function write(p: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Does not persist this session; nothing depends on it.
  }
}

/** Union newly-seen stages into the record. Writes only when something is new. */
export function recordStages(seen: Iterable<Stage>): void {
  const p = readProgress();
  const set = new Set(p.stages);
  let changed = false;
  for (const s of seen) {
    if (!set.has(s)) {
      set.add(s);
      changed = true;
    }
  }
  if (changed) write({ ...p, stages: [...set] });
}

export function recordPrediction(correct: boolean): void {
  const p = readProgress();
  write({ ...p, asked: p.asked + 1, right: p.right + (correct ? 1 : 0) });
}

export function clearProgress(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Same as above.
  }
}
