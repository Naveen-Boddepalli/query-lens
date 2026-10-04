import { useCallback, useEffect, useRef, useState } from 'react';
import type { Database } from '../engine/index.ts';
import { btnGhost, btnPrimary, btnSecondary, inputField } from './primitives.ts';
import {
  deleteSavedQuery,
  deleteWorkspace,
  listSavedQueries,
  listWorkspaces,
  openWorkspace,
  parseWorkspaceFile,
  saveQuery,
  saveWorkspace,
  workspaceFileText,
  workspaceNameProblem,
} from './workspaces.ts';
import type { SavedQuery, WorkspaceSummary } from './workspaces.ts';

export interface WorkspaceDialogProps {
  db: Database;
  /** The SQL in the editor, which "Save query" keeps. */
  sql: string;
  onOpen: (db: Database) => void;
  onLoadQuery: (sql: string) => void;
  onClose: () => void;
}

const UNAVAILABLE = 'Saved workspaces are not available in this browser, so they cannot be kept here.';

export function WorkspaceDialog({ db, sql, onOpen, onLoadQuery, onClose }: WorkspaceDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<WorkspaceSummary[]>([]);
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [queryName, setQueryName] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSaved(await listWorkspaces());
    } catch {
      setSaved([]);
      setMessage(UNAVAILABLE);
    }
  }, []);

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    listWorkspaces().then(
      (found) => { setSaved(found); },
      () => {
        setSaved([]);
        setMessage(UNAVAILABLE);
      },
    );
    listSavedQueries().then(
      (found) => { setQueries(found); },
      () => { setQueries([]); },
    );
  }, []);

  const close = () => { dialog.current?.close(); };

  async function save() {
    const problem = workspaceNameProblem(name);
    if (problem) {
      setMessage(problem);
      return;
    }
    const label = name.trim();
    try {
      await saveWorkspace(label, db);
      setName('');
      setMessage(`Saved "${label}".`);
      await refresh();
    } catch {
      setMessage('That did not save. The browser may be out of space, or blocking storage.');
    }
  }

  async function keepQuery() {
    const problem = workspaceNameProblem(queryName);
    if (problem) {
      setMessage(problem);
      return;
    }
    if (sql.trim() === '') {
      setMessage('The editor is empty, so there is no query to save.');
      return;
    }
    const label = queryName.trim();
    try {
      await saveQuery(label, sql);
      setQueryName('');
      setQueries(await listSavedQueries());
      setMessage(`Saved the query "${label}".`);
    } catch {
      setMessage('That query did not save. The browser may be out of space, or blocking storage.');
    }
  }

  async function removeQuery(target: string) {
    if (!window.confirm(`Delete the saved query "${target}"?`)) return;
    try {
      await deleteSavedQuery(target);
      setQueries(await listSavedQueries());
      setMessage(`Deleted the query "${target}".`);
    } catch {
      setMessage(UNAVAILABLE);
    }
  }

  async function open(target: string) {
    if (!window.confirm(`Replace the database in this tab with "${target}"? The current one is replaced too, so save it first to keep it.`)) return;
    try {
      const next = await openWorkspace(target);
      if (next === null) {
        setMessage(`"${target}" no longer checks out, so it was not opened.`);
        return;
      }
      onOpen(next);
    } catch {
      setMessage(UNAVAILABLE);
    }
  }

  async function remove(target: string) {
    if (!window.confirm(`Delete the saved workspace "${target}"? This cannot be undone.`)) return;
    try {
      await deleteWorkspace(target);
      setMessage(`Deleted "${target}".`);
      await refresh();
    } catch {
      setMessage(UNAVAILABLE);
    }
  }

  function download() {
    const label = name.trim() || 'custom-database';
    const json = workspaceFileText(label, db);
    const a = document.createElement('a');
    a.href = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
    a.download = `${label.replace(/[^A-Za-z0-9_-]+/g, '-')}.querylens.json`;
    a.click();
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setMessage('That file could not be read.');
      return;
    }
    const parsed = parseWorkspaceFile(text);
    if (!parsed.ok) {
      setMessage(parsed.problem);
      return;
    }
    if (!window.confirm(`Open "${parsed.name}" from this file? It replaces the database in this tab.`)) return;
    onOpen(parsed.database);
  }

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialog}
      aria-label="Workspaces"
      onClose={onClose}
      onClick={(e) => { if (e.target === dialog.current) close(); }}
      className="max-h-[85dvh] w-[min(40rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-edge bg-surface p-0 text-ink shadow-e3 backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="flex max-h-[85dvh] flex-col">
        <header className="flex items-center gap-3 border-b border-edge bg-surface-2/40 px-4 py-3">
          <h2 className="text-heading font-semibold">Workspaces</h2>
          <button type="button" onClick={close} className={`ml-auto ${btnGhost}`}>
            Close
          </button>
        </header>

        <div className="space-y-5 overflow-y-auto p-4">
          <section className="space-y-2">
            <h3 className="text-body font-semibold">Save this database</h3>
            <p className="text-label text-ink-dim">
              A saved workspace is kept in this browser, separately from the working copy, and is not limited to the
              size of the working copy.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex flex-1 flex-col gap-1 text-label text-ink-dim">
                Name
                <input
                  value={name}
                  onChange={(e) => { setName(e.target.value); }}
                  placeholder="e.g. Week 3 lab"
                  className={inputField}
                />
              </label>
              <button type="button" onClick={() => { void save(); }} className={btnPrimary}>
                Save
              </button>
              <button type="button" onClick={download} className={btnSecondary}>
                Download as a file
              </button>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-body font-semibold">Saved here</h3>
            {saved.length === 0 ? (
              <p className="text-label text-ink-dim">Nothing saved yet.</p>
            ) : (
              <ul className="space-y-2">
                {saved.map((w) => (
                  <li key={w.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-surface-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{w.name}</p>
                      <p className="text-label text-ink-dim">
                        {w.tables} table{w.tables === 1 ? '' : 's'} · saved {new Date(w.savedAt).toLocaleString()}
                      </p>
                    </div>
                    <button type="button" onClick={() => { void open(w.name); }} className={btnSecondary}>
                      Open
                    </button>
                    <button type="button" onClick={() => { void remove(w.name); }} className={btnGhost}>
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-body font-semibold">Saved queries</h3>
            <p className="text-label text-ink-dim">
              A query kept here loads back into the editor. It is not run until you press Run.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex flex-1 flex-col gap-1 text-label text-ink-dim">
                Query name
                <input
                  value={queryName}
                  onChange={(e) => { setQueryName(e.target.value); }}
                  placeholder="e.g. authors with posts"
                  className={inputField}
                />
              </label>
              <button type="button" onClick={() => { void keepQuery(); }} className={btnSecondary}>
                Save query
              </button>
            </div>
            {queries.length === 0 ? (
              <p className="text-label text-ink-dim">No saved queries yet.</p>
            ) : (
              <ul className="space-y-2">
                {queries.map((q) => (
                  <li key={q.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-surface-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{q.name}</p>
                      <p className="truncate font-mono text-label text-ink-dim">{q.sql}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        onLoadQuery(q.sql);
                        close();
                      }}
                      className={btnSecondary}
                    >
                      Load
                    </button>
                    <button type="button" onClick={() => { void removeQuery(q.name); }} className={btnGhost}>
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-body font-semibold">Open a file</h3>
            <p className="text-label text-ink-dim">
              A file downloaded from another browser. It is checked in full before anything is opened.
            </p>
            <input
              type="file"
              accept=".json,application/json"
              aria-label="Workspace file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                void importFile(file);
              }}
              className="text-label text-ink-dim file:mr-3 file:rounded-md file:border file:border-edge file:bg-surface-3 file:px-3 file:py-1.5 file:text-ink"
            />
          </section>

          {message !== null && (
            <p role="status" className="text-label text-ink-dim">
              {message}
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}
