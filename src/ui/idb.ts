/**
 * plan.md §H7: the one IndexedDB database QueryLens keeps in this browser. Saved workspaces, saved queries and the live
 * working copy of a custom database each have their own object store here. A connection is opened once and reused, and
 * dropped when the browser asks for the database to be closed or when an open fails, so the next call tries again.
 */

const DB_NAME = 'querylens';
const DB_VERSION = 3;

export const STORES = {
  workspaces: 'workspaces',
  queries: 'queries',
  working: 'working',
} as const;

let connection: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const store of Object.values(STORES)) {
        if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store, { keyPath: 'name' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      connection = null;
      reject(request.error ?? new Error('IndexedDB could not be opened'));
    };
  });
  return connection;
}

export async function run<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const request = action(db.transaction(storeName, mode).objectStore(storeName));
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB request failed')); };
  });
}
