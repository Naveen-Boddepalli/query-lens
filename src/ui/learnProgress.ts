/**
 * Which `/learn` lessons the visitor has marked complete. Same try/catch
 * discipline as `preferences.ts` and `theme.ts`: private mode or blocked site
 * data must degrade to "nothing completed", never throw.
 *
 * This is a *convenience*, not state anything depends on — a lost set just
 * means the checkmarks reset. It is per-browser and never leaves it.
 */

const KEY = 'querylens:learn';

export function readCompleted(): Set<string> {
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

function write(ids: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // Progress does not persist this session; nothing else depends on it.
  }
}

export function setCompleted(id: string, done: boolean): Set<string> {
  const ids = readCompleted();
  if (done) ids.add(id);
  else ids.delete(id);
  write(ids);
  return ids;
}

export function clearCompleted(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Same as above.
  }
}
