import type { Stage } from '../engine/index.ts';

/**
 * plan.md §22.4: a little of what the visitor has done, for the `/progress`
 * dashboard that feeds the second visit (§21.2). Same discipline as
 * `learnProgress.ts` / `preferences.ts` / `theme.ts` — a *convenience*, never
 * state anything depends on: private mode or blocked site data degrades to
 * "nothing tracked", never throws. Per-browser, never leaves it.
 */

const KEY = 'querylens:progress';

/** plan.md §G2: how sure the visitor said they were before committing to a prediction. */
export type Confidence = 'guessing' | 'fairly-sure' | 'certain';
export const CONFIDENCE_LEVELS: readonly Confidence[] = ['guessing', 'fairly-sure', 'certain'];
export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  guessing: 'Guessing',
  'fairly-sure': 'Fairly sure',
  certain: 'Certain',
};

export interface Tally {
  asked: number;
  right: number;
}

export interface Progress {
  /** Pipeline stages the visitor has seen in a trace at least once. */
  stages: Stage[];
  /** Predictions committed to (a skip does not count). */
  asked: number;
  /** ...of which correct. */
  right: number;
  /** The same counts, split by the confidence rated before the commit. Unrated predictions are not in here. */
  byConfidence: Record<Confidence, Tally>;
}

function emptyProgress(): Progress {
  return {
    stages: [],
    asked: 0,
    right: 0,
    byConfidence: { guessing: { asked: 0, right: 0 }, 'fairly-sure': { asked: 0, right: 0 }, certain: { asked: 0, right: 0 } },
  };
}

function count(value: unknown): number {
  return typeof value === 'number' && value >= 0 ? Math.floor(value) : 0;
}

export function readProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyProgress();
    const p = JSON.parse(raw) as Record<string, unknown>;
    const stored = (typeof p.byConfidence === 'object' && p.byConfidence !== null ? p.byConfidence : {}) as Record<string, unknown>;
    const byConfidence = emptyProgress().byConfidence;
    for (const level of CONFIDENCE_LEVELS) {
      const t = stored[level] as Partial<Record<keyof Tally, unknown>> | undefined;
      byConfidence[level] = { asked: count(t?.asked), right: count(t?.right) };
    }
    return {
      stages: Array.isArray(p.stages)
        ? p.stages.filter((s): s is Stage => typeof s === 'string')
        : [],
      asked: count(p.asked),
      right: count(p.right),
      byConfidence,
    };
  } catch {
    return emptyProgress();
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

export function recordPrediction(correct: boolean, confidence?: Confidence): void {
  const p = readProgress();
  const byConfidence = { ...p.byConfidence };
  if (confidence) {
    const t = byConfidence[confidence];
    byConfidence[confidence] = { asked: t.asked + 1, right: t.right + (correct ? 1 : 0) };
  }
  write({ ...p, asked: p.asked + 1, right: p.right + (correct ? 1 : 0), byConfidence });
}

export function clearProgress(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Same as above.
  }
}
