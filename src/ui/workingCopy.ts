/**
 * plan.md §H7: the live working copy of the custom database, kept in IndexedDB. The Playground autosaves to it on every
 * change. It used to live in `localStorage`, which is capped at about 5 MB; a copy still there from then is moved across
 * once, the first time it is loaded, and the old copy is removed only after the new one is written.
 *
 * Nothing here throws into the page: a copy that cannot be read is the starter database, and a failed save leaves the
 * session working, because nothing depends on the autosave surviving.
 */
import type { Database } from '../engine/index.ts';
import { isValidDatabase, starterCustomDatabase } from './customDatabase.ts';
import { run, STORES } from './idb.ts';

const RECORD = 'working';
const LEGACY_KEY = 'querylens.customDatabase.v1';

interface Stored {
  name: string;
  savedAt: number;
  database: Database;
}

function readLegacy(): Database | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidDatabase(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clearLegacy(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Storage unavailable: the old copy stays, and is ignored from now on, since IndexedDB has its own.
  }
}

export async function loadWorkingCopy(): Promise<Database> {
  try {
    const stored = await run<Stored | undefined>(
      STORES.working,
      'readonly',
      (store) => store.get(RECORD) as IDBRequest<Stored | undefined>,
    );
    if (stored !== undefined && isValidDatabase(stored.database)) return stored.database;
    const legacy = readLegacy();
    if (legacy !== null) {
      await saveWorkingCopy(legacy);
      clearLegacy();
      return legacy;
    }
    return starterCustomDatabase();
  } catch {
    return starterCustomDatabase();
  }
}

export async function saveWorkingCopy(database: Database): Promise<void> {
  const record: Stored = { name: RECORD, savedAt: Date.now(), database };
  await run(STORES.working, 'readwrite', (store) => store.put(record));
}
