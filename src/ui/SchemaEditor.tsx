import { useEffect, useRef, useState } from 'react';
import type { Database } from '../engine/index.ts';
import { parseColumnList, validateNewTable } from './customDatabase.ts';
import { DataEditor } from './DataEditor.tsx';
import { btnGhost, btnPrimary, btnSecondary, inputField } from './primitives.ts';

/**
 * plan.md §22.7: the multi-table counterpart to `DataEditor` — add a table
 * (name, columns, an optional index), remove one, or open its rows for
 * editing (`DataEditor` itself, nested — native `<dialog>`s stack fine, and
 * this is the only caller that ever passes it without an `onReset`, since a
 * user-authored table has no "original seed" to revert to). Every edit here
 * is staged in `working` and only reaches the Playground on "Apply" — the
 * same commit-on-apply shape `DataEditor` already uses, so closing without
 * applying is a clean cancel.
 */
/** Caps the undo stack so a long editing session can't grow it unboundedly. */
const MAX_HISTORY = 50;

export interface SchemaEditorProps {
  db: Database;
  onApply: (next: Database) => void;
  onClose: () => void;
}

export function SchemaEditor({ db, onApply, onClose }: SchemaEditorProps) {
  const [working, setWorking] = useState<Database>(db);
  const [editingTable, setEditingTable] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [columnsInput, setColumnsInput] = useState('');
  const [indexInput, setIndexInput] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  // Undo/redo over the whole `working` database. Every mutation here is
  // already a discrete, deliberate action (add a table, remove one, commit a
  // table's edited rows) rather than a per-keystroke one, so — unlike
  // DataEditor's own coalesced cell edits — each gets its own history entry.
  const [past, setPast] = useState<Database[]>([]);
  const [future, setFuture] = useState<Database[]>([]);

  const pushHistory = () => {
    setPast((p) => [...p, working].slice(-MAX_HISTORY));
    setFuture([]);
  };

  const undo = () => {
    if (past.length === 0) return;
    const previous = past[past.length - 1]!;
    setPast(past.slice(0, -1));
    setFuture([working, ...future]);
    setWorking(previous);
  };

  const redo = () => {
    if (future.length === 0) return;
    const next = future[0]!;
    setFuture(future.slice(1));
    setPast([...past, working].slice(-MAX_HISTORY));
    setWorking(next);
  };

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);

  const close = () => { dialog.current?.close(); };

  const columns = parseColumnList(columnsInput);

  function addTable() {
    const problem = validateNewTable(working, { name: nameInput, columns });
    if (problem) {
      setError(problem);
      return;
    }
    pushHistory();
    setWorking((current) => ({
      tables: {
        ...current.tables,
        [nameInput]: {
          name: nameInput,
          columns,
          rows: [],
          ...(indexInput.length > 0 ? { indexedColumns: indexInput } : {}),
        },
      },
    }));
    setAdding(false);
    setNameInput('');
    setColumnsInput('');
    setIndexInput([]);
    setError(null);
  }

  function removeTable(name: string) {
    pushHistory();
    setWorking((current) => {
      const { [name]: _removed, ...rest } = current.tables;
      return { tables: rest };
    });
  }

  const tableNames = Object.keys(working.tables).sort();

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <dialog
      ref={dialog}
      aria-label="Manage tables"
      onClose={onClose}
      onClick={(e) => { if (e.target === dialog.current) close(); }}
      className="ql-sheen max-h-[85dvh] w-[min(40rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-edge bg-surface p-0 text-ink shadow-e3 backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    >
      <div className="flex max-h-[85dvh] flex-col">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge bg-surface-2/40 px-4 py-3">
          <h2 className="text-heading font-semibold">Manage tables</h2>
          <p className="text-label text-ink-dim">
            {tableNames.length} table{tableNames.length === 1 ? '' : 's'}
          </p>
          <button type="button" onClick={close} className={`ml-auto ${btnGhost}`}>
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-2 overflow-auto px-4 py-3">
          {tableNames.length === 0 && (
            <p className="text-label text-ink-dim">No tables yet — add one below.</p>
          )}
          {tableNames.map((name) => {
            const table = working.tables[name]!;
            return (
              <div
                key={name}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-edge bg-surface-2 p-2.5"
              >
                <span className="font-mono text-body font-medium text-ink">{name}</span>
                <span className="text-label text-ink-dim">
                  {table.columns.join(', ')}
                  {table.indexedColumns && table.indexedColumns.length > 0 && ` · indexed on ${table.indexedColumns.join(', ')}`}
                </span>
                <span className="text-label text-ink-dim/80">
                  {table.rows.length} row{table.rows.length === 1 ? '' : 's'}
                </span>
                <span className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setEditingTable(name); }}
                    className={btnSecondary}
                  >
                    Edit rows
                  </button>
                  <button
                    type="button"
                    onClick={() => { removeTable(name); }}
                    className="rounded-lg px-2 py-1 text-label text-ink-dim transition hover:text-evict"
                  >
                    Remove
                  </button>
                </span>
              </div>
            );
          })}
        </div>

        <div className="border-t border-edge bg-surface-2/40 px-4 py-3">
          {adding ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <label className="flex flex-col gap-1 text-label text-ink-dim">
                  Table name
                  <input
                    value={nameInput}
                    onChange={(e) => { setNameInput(e.target.value); setError(null); }}
                    placeholder="reviews"
                    className={`${inputField} font-mono`}
                    spellCheck={false}
                  />
                </label>
                <label className="flex flex-1 min-w-48 flex-col gap-1 text-label text-ink-dim">
                  Columns (comma-separated)
                  <input
                    value={columnsInput}
                    onChange={(e) => { setColumnsInput(e.target.value); setError(null); }}
                    placeholder="id, rating, comment"
                    className={`${inputField} font-mono`}
                    spellCheck={false}
                  />
                </label>
                <label className="flex flex-col gap-1 text-label text-ink-dim">
                  Indexes (⌘/Ctrl-click for more than one)
                  <select
                    multiple
                    value={indexInput}
                    onChange={(e) => {
                      setIndexInput([...e.target.selectedOptions].map((o) => o.value));
                    }}
                    className={`${inputField} h-auto`}
                    size={Math.min(4, Math.max(2, columns.length || 1))}
                  >
                    {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>
              {error && <p role="alert" className="text-label text-evict">{error}</p>}
              <div className="flex gap-2">
                <button type="button" onClick={addTable} className={btnPrimary}>
                  Add table
                </button>
                <button
                  type="button"
                  onClick={() => { setAdding(false); setError(null); }}
                  className={btnGhost}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={undo}
                disabled={past.length === 0}
                aria-label="Undo"
                title="Undo"
                className={`${btnGhost} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                Undo
              </button>
              <button
                type="button"
                onClick={redo}
                disabled={future.length === 0}
                aria-label="Redo"
                title="Redo"
                className={`${btnGhost} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                Redo
              </button>
              <button type="button" onClick={() => { setAdding(true); }} className={btnSecondary}>
                + Add table
              </button>
              <button
                type="button"
                onClick={() => { close(); onApply(working); }}
                className={`ml-auto ${btnPrimary}`}
              >
                Apply &amp; re-run
              </button>
            </div>
          )}
        </div>
      </div>

      {editingTable && working.tables[editingTable] && (
        <DataEditor
          table={working.tables[editingTable]}
          onApply={(rows) => {
            pushHistory();
            setWorking((current) => ({
              tables: { ...current.tables, [editingTable]: { ...current.tables[editingTable]!, rows } },
            }));
            setEditingTable(null);
          }}
          onClose={() => { setEditingTable(null); }}
        />
      )}
    </dialog>
  );
}
