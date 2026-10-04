/**
 * plan.md §H7, slice 1: named workspaces — snapshots of a custom database kept in IndexedDB, which is not capped at
 * `localStorage`'s ~5 MB, plus a JSON file format for moving one between browsers. The live working copy still
 * autosaves to `localStorage` (`customDatabase.ts`); this module is the library around it, not a replacement.
 *
 * Every read goes through the validator the working copy uses, so a stored snapshot or a file that does not describe
 * a valid database is refused whole, never half-loaded.
 */
import type { Database } from '../engine/index.ts';
import { isValidDatabase } from './customDatabase.ts';

export const WORKSPACE_FORMAT = 'querylens-workspace';
export const WORKSPACE_VERSION = 1;

const DB_NAME = 'querylens';
const DB_VERSION = 2;
const STORE = 'workspaces';
const QUERIES = 'queries';
const MAX_NAME_LENGTH = 60;

export interface SavedQuery {
  name: string;
  sql: string;
  savedAt: number;
}

export interface WorkspaceSummary {
  name: string;
  savedAt: number;
  tables: number;
}

interface StoredWorkspace {
  name: string;
  savedAt: number;
  database: Database;
}

export type ParsedWorkspaceFile = { ok: true; name: string; database: Database } | { ok: false; problem: string };

export function workspaceNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Name the workspace.';
  if (trimmed.length > MAX_NAME_LENGTH) return `Keep the name to ${String(MAX_NAME_LENGTH)} characters.`;
  return null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const store of [STORE, QUERIES]) {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'name' });
      }
    };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB could not be opened')); };
  });
}

async function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(storeName, mode).objectStore(storeName));
      request.onsuccess = () => { resolve(request.result); };
      request.onerror = () => { reject(request.error ?? new Error('IndexedDB request failed')); };
    });
  } finally {
    db.close();
  }
}

export async function listWorkspaces(): Promise<WorkspaceSummary[]> {
  const stored = await run<StoredWorkspace[]>(STORE, 'readonly', (store) => store.getAll() as IDBRequest<StoredWorkspace[]>);
  return stored
    .filter((w) => isValidDatabase(w.database))
    .map((w) => ({ name: w.name, savedAt: w.savedAt, tables: Object.keys(w.database.tables).length }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function saveWorkspace(name: string, database: Database): Promise<void> {
  const record: StoredWorkspace = { name: name.trim(), savedAt: Date.now(), database };
  await run(STORE, 'readwrite', (store) => store.put(record));
}

export async function openWorkspace(name: string): Promise<Database | null> {
  const stored = await run<StoredWorkspace | undefined>(
    STORE,
    'readonly',
    (store) => store.get(name) as IDBRequest<StoredWorkspace | undefined>,
  );
  return stored !== undefined && isValidDatabase(stored.database) ? stored.database : null;
}

export async function deleteWorkspace(name: string): Promise<void> {
  await run(STORE, 'readwrite', (store) => store.delete(name));
}

export function workspaceFileText(name: string, database: Database): string {
  return JSON.stringify({ format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION, name: name.trim(), database }, null, 2);
}

export function parseWorkspaceFile(text: string): ParsedWorkspaceFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'That file is not JSON, so it is not a QueryLens workspace.' };
  }
  const file = parsed as { format?: unknown; version?: unknown; name?: unknown; database?: unknown } | null;
  if (typeof file !== 'object' || file === null || file.format !== WORKSPACE_FORMAT) {
    return { ok: false, problem: 'That file is not a QueryLens workspace.' };
  }
  if (file.version !== WORKSPACE_VERSION) {
    return {
      ok: false,
      problem: `This workspace is version ${String(file.version)}; this QueryLens reads version ${String(WORKSPACE_VERSION)}.`,
    };
  }
  if (typeof file.name !== 'string' || workspaceNameProblem(file.name) !== null) {
    return { ok: false, problem: 'The workspace has no usable name, so nothing was loaded.' };
  }
  if (!isValidDatabase(file.database)) {
    return { ok: false, problem: "The workspace's tables do not check out, so nothing was loaded." };
  }
  return { ok: true, name: file.name.trim(), database: file.database };
}

export async function listSavedQueries(): Promise<SavedQuery[]> {
  const stored = await run<SavedQuery[]>(QUERIES, 'readonly', (store) => store.getAll() as IDBRequest<SavedQuery[]>);
  return stored.sort((a, b) => b.savedAt - a.savedAt);
}

export async function saveQuery(name: string, sql: string): Promise<void> {
  const record: SavedQuery = { name: name.trim(), sql: sql.trim(), savedAt: Date.now() };
  await run(QUERIES, 'readwrite', (store) => store.put(record));
}

export async function deleteSavedQuery(name: string): Promise<void> {
  await run(QUERIES, 'readwrite', (store) => store.delete(name));
}
