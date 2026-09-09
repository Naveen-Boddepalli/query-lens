/**
 * Which `/challenges` puzzles the visitor has solved. Same discipline as
 * `learnProgress.ts` / `progress.ts` — a per-browser convenience that degrades
 * to "none solved" and never throws.
 */

const KEY = 'querylens:challenges';

export function readSolved(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((x): x is string => typeof x === 'string'))
      : new Set();
  } catch {
    return new Set();
  }
}

export function markSolved(id: string): Set<string> {
  const ids = readSolved();
  if (!ids.has(id)) {
    ids.add(id);
    try {
      localStorage.setItem(KEY, JSON.stringify([...ids]));
    } catch {
      // Does not persist this session; nothing depends on it.
    }
  }
  return ids;
}

export function clearSolved(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Same as above.
  }
}
