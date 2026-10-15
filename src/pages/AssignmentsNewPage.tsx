import { useMemo, useState } from 'react';
import {
  createSeedDatabase,
  DEFAULT_ENGINE_OPTIONS,
  runQuery,
} from '../engine/index.ts';
import { REPLACEMENT_POLICY_LABELS, REPLACEMENT_POLICY_NAMES } from '../engine/types.ts';
import type { ReplacementPolicyName } from '../engine/index.ts';
import { encodeShareState } from '../ui/urlState.ts';
import { serializeSet, worksheet } from '../ui/assignmentSet.ts';
import type { AssignmentItem } from '../ui/assignmentSet.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnGhost, btnPrimary, btnSecondary, card, inputField } from '../ui/primitives.ts';

/**
 * plan.md §20.5 / §21.3: "assignment links", the part of the EdTech idea that
 * needs no backend. The shareable URL (`src/ui/urlState.ts`) already encodes
 * a query, a policy and a step; prediction prompts are generated from real
 * engine state, so "predict what happens at step 13" is already `?s=13&x=1`.
 * What was missing was this authoring surface. There is deliberately no
 * server-side id and no submission — that half (§20.5's "graded execution")
 * needs a store and a privacy statement of its own, and stays its own plan.
 */

const SEED = createSeedDatabase();

const PRESETS = [
  { label: 'Point lookup (indexed)', sql: 'SELECT * FROM users WHERE id = 5;' },
  { label: 'Sequential scan', sql: 'SELECT * FROM users WHERE age > 30;' },
  { label: 'Select every row', sql: 'SELECT * FROM users;' },
] as const;

export function AssignmentsNewPage() {
  const [sql, setSql] = useState<string>(PRESETS[0].sql);
  const [policy, setPolicy] = useState<ReplacementPolicyName>('lru');
  const [step, setStep] = useState(1);
  const [lockReveal, setLockReveal] = useState(true);
  const [copied, setCopied] = useState(false);

  // plan.md §22.4: bundle several links into one sheet.
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [items, setItems] = useState<AssignmentItem[]>([]);
  const [sheetCopied, setSheetCopied] = useState(false);

  const trace = useMemo(
    () => runQuery(sql, SEED, { ...DEFAULT_ENGINE_OPTIONS, policy }),
    [sql, policy],
  );

  const clampedStep = trace.error ? 0 : Math.max(0, Math.min(step, trace.events.length));

  // Whether the landing step (or, if it has no prompt, any later step) actually
  // asks a question — the lock does nothing without one.
  const promptAhead = !trace.error && trace.events.slice(clampedStep).some((e) => e.predictable);

  const link = useMemo(() => {
    if (typeof location === 'undefined' || trace.error) return '';
    const query = encodeShareState(
      { sql, policy, predictOn: true, step: clampedStep, ...(lockReveal ? { lockReveal: true } : {}) },
      undefined,
    );
    return `${location.origin}/playground?${query}`;
  }, [sql, policy, clampedStep, lockReveal, trace.error]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => { setCopied(false); }, 2000);
    } catch {
      setCopied(false);
    }
  }

  function addToSet() {
    if (!link) return;
    setItems((prev) => [...prev, { label, link }]);
    setLabel('');
  }

  async function copySheet() {
    try {
      await navigator.clipboard.writeText(worksheet(code, items));
      setSheetCopied(true);
      window.setTimeout(() => { setSheetCopied(false); }, 2000);
    } catch {
      setSheetCopied(false);
    }
  }

  function downloadSet() {
    const a = document.createElement('a');
    a.href = `data:application/json;charset=utf-8,${encodeURIComponent(serializeSet(code, items))}`;
    a.download = `${code.trim() || 'assignment'}-set.json`;
    a.click();
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <PageHeader eyebrow="For instructors" title="Create an assignment">
        Pick a query, a policy and a step, and get a link. Opening it lands the reader on that
        exact step with prediction switched on, so the first thing they do is answer a question
        rather than read background. With the reveal locked, they cannot scrub or skip past that
        question until they commit. No account, no submission — the link <em>is</em> the
        assignment.
      </PageHeader>

      <div className={`mt-8 space-y-4 ${card}`}>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Query
          <select
            value={PRESETS.some((p) => p.sql === sql) ? sql : 'custom'}
            onChange={(e) => { if (e.target.value !== 'custom') setSql(e.target.value); }}
            className={inputField}
          >
            {PRESETS.map((p) => (
              <option key={p.label} value={p.sql}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom (edit below)</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          SQL
          <textarea
            value={sql}
            onChange={(e) => { setSql(e.target.value); }}
            rows={3}
            spellCheck={false}
            className={`${inputField} font-mono`}
          />
        </label>

        {trace.error && (
          <p className="text-label text-evict">{trace.error.message}</p>
        )}

        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-label text-ink-dim">
            Eviction policy
            <select
              value={policy}
              onChange={(e) => { setPolicy(e.target.value as ReplacementPolicyName); }}
              className={inputField}
            >
              {REPLACEMENT_POLICY_NAMES.map((name) => (
                <option key={name} value={name}>
                  {REPLACEMENT_POLICY_LABELS[name]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-label text-ink-dim">
            Land on step
            <input
              type="number"
              min={0}
              max={trace.events.length}
              value={clampedStep}
              onChange={(e) => { setStep(Number(e.target.value)); }}
              disabled={!!trace.error}
              className={`${inputField} w-24 tabular-nums`}
            />
          </label>

          {!trace.error && (
            <p className="self-end pb-1.5 text-label text-ink-dim">
              of {trace.events.length} steps in this trace
            </p>
          )}
        </div>

        <label className="flex items-start gap-2 text-label text-ink-dim">
          <input
            type="checkbox"
            checked={lockReveal}
            onChange={(e) => { setLockReveal(e.target.checked); }}
            className="mt-0.5 accent-[var(--color-accent)]"
          />
          <span>
            Lock the reveal until they answer
            {lockReveal && !promptAhead && !trace.error && (
              <span className="block text-evict">
                No prediction prompt at or after this step — the lock will have no effect here.
              </span>
            )}
          </span>
        </label>
      </div>

      {link && (
        <div className="ql-sheen mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
          <code className="min-w-0 flex-1 truncate font-mono text-label text-ink">{link}</code>
          <button type="button" onClick={() => { void copyLink(); }} className={btnPrimary}>
            {copied ? 'Copied ✓' : 'Copy link'}
          </button>
          <input
            type="text"
            value={label}
            onChange={(e) => { setLabel(e.target.value); }}
            placeholder="label (optional)"
            aria-label="Assignment label"
            className={`${inputField} w-40`}
          />
          <button type="button" onClick={addToSet} className={btnSecondary}>
            Add to set
          </button>
        </div>
      )}

      {items.length > 0 && (
        <div className={`mt-4 space-y-3 ${card}`}>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-label text-ink-dim">
              Class code
              <input
                type="text"
                value={code}
                onChange={(e) => { setCode(e.target.value); }}
                placeholder="e.g. CS564-fall"
                className={`${inputField} w-48`}
              />
            </label>
            <p className="pb-1.5 text-label text-ink-dim">
              {items.length} assignment{items.length === 1 ? '' : 's'} in this set
            </p>
          </div>

          <ol className="space-y-1.5">
            {items.map((item, i) => (
              <li
                key={`${String(i)}-${item.link}`}
                className="flex items-baseline gap-2 rounded-lg border border-edge bg-surface-3 px-2.5 py-1.5 text-label"
              >
                <span className="font-mono text-ink-dim tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-ink">
                  {item.label.trim() || `Assignment ${String(i + 1)}`}
                </span>
                <button
                  type="button"
                  onClick={() => { setItems((prev) => prev.filter((_, j) => j !== i)); }}
                  aria-label={`Remove assignment ${String(i + 1)}`}
                  className="shrink-0 rounded px-1 text-ink-dim hover:text-evict"
                >
                  ×
                </button>
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => { void copySheet(); }} className={btnPrimary}>
              {sheetCopied ? 'Copied ✓' : 'Copy worksheet'}
            </button>
            <button type="button" onClick={downloadSet} className={btnSecondary}>
              Download JSON
            </button>
            <button type="button" onClick={() => { setItems([]); }} className={btnGhost}>
              Clear set
            </button>
          </div>
          <p className="text-label text-ink-dim">
            The worksheet is Markdown — a numbered list of links to paste into your LMS or print.
            The JSON keeps the same set for your records.
          </p>
        </div>
      )}
    </div>
  );
}
