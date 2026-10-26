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
import { btnGhost, btnPrimary, btnSecondary, card, inputField, panelSurface } from '../ui/primitives.ts';

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
  ['Point lookup (indexed)', 'SELECT * FROM users WHERE id = 5;'],
  ['Sequential scan', 'SELECT * FROM users WHERE age > 30;'],
  ['Select every row', 'SELECT * FROM users;'],
] as const;

export function AssignmentsNewPage() {
  const [sql, setSql] = useState<string>(PRESETS[0][1]);
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

  const targetEvent = !trace.error && clampedStep > 0 ? trace.events[clampedStep - 1] : null;

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
    <div className="mx-auto w-full max-w-3xl p-6 sm:p-8">
      <PageHeader eyebrow="For instructors" title="Create an assignment">
        Configure a query, eviction policy, and step target to generate an instant assignment link.
        Students land directly on that step with prediction activated, requiring them to commit
        to an answer before proceeding. No accounts or server dependencies required — the URL{' '}
        <em>is</em> the assignment.
      </PageHeader>

      <div className={`mt-8 space-y-5 ${card}`}>
        <div className="border-b border-edge/60 pb-3">
          <span className="font-mono text-label font-semibold uppercase tracking-wider text-ink">
            Step 1: Query & Configuration
          </span>
        </div>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Preset query
          <select
            value={PRESETS.some(([, s]) => s === sql) ? sql : 'custom'}
            onChange={(e) => { if (e.target.value !== 'custom') setSql(e.target.value); }}
            className={inputField}
          >
            {PRESETS.map(([lbl, s]) => (
              <option key={lbl} value={s}>
                {lbl}
              </option>
            ))}
            <option value="custom">Custom SQL query</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          SQL statement
          <textarea
            value={sql}
            onChange={(e) => { setSql(e.target.value); }}
            rows={3}
            spellCheck={false}
            className={`${inputField} font-mono`}
          />
        </label>

        {trace.error && (
          <div className="rounded-lg border border-evict/40 bg-evict/10 p-3 text-label text-evict">
            {trace.error.message}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-4 border-t border-edge/60 pt-4">
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
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={trace.events.length}
                value={clampedStep}
                onChange={(e) => { setStep(Number(e.target.value)); }}
                disabled={!!trace.error}
                className={`${inputField} w-24 tabular-nums`}
              />
              <button
                type="button"
                onClick={() => { setStep((s) => Math.max(0, s - 1)); }}
                disabled={clampedStep <= 0 || !!trace.error}
                className="rounded border border-edge bg-surface-3 px-2 py-1 text-label text-ink-dim hover:text-ink disabled:opacity-40"
                aria-label="Previous step"
              >
                -
              </button>
              <button
                type="button"
                onClick={() => { setStep((s) => Math.min(trace.events.length, s + 1)); }}
                disabled={clampedStep >= trace.events.length || !!trace.error}
                className="rounded border border-edge bg-surface-3 px-2 py-1 text-label text-ink-dim hover:text-ink disabled:opacity-40"
                aria-label="Next step"
              >
                +
              </button>
            </div>
          </label>

          {!trace.error && (
            <div className="pb-1 text-label text-ink-dim">
              <span>of {trace.events.length} steps in this trace</span>
              {targetEvent && (
                <span className="ml-2 font-mono text-[11px] text-accent">
                  (Stage: {targetEvent.stage})
                </span>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-edge/60 pt-4">
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
      </div>

      {/* Instant Preview & Share Link Generator */}
      {link && (
        <div className={`mt-5 space-y-3 ${panelSurface} p-4`}>
          <div className="flex items-center justify-between">
            <span className="font-mono text-label font-semibold uppercase tracking-wider text-ink">
              Preview & Link Generator
            </span>
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              className="text-label text-accent underline underline-offset-2 hover:text-ink"
            >
              Test link
            </a>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-edge bg-surface/80 p-2 font-mono text-label text-ink">
              {link}
            </code>
            <button type="button" onClick={() => { void copyLink(); }} className={btnPrimary}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-edge/60 pt-3">
            <input
              type="text"
              value={label}
              onChange={(e) => { setLabel(e.target.value); }}
              placeholder="Assignment label (e.g. Inspect clock eviction)"
              aria-label="Assignment label"
              className={`${inputField} flex-1`}
            />
            <button type="button" onClick={addToSet} className={btnSecondary}>
              Add to set
            </button>
          </div>
        </div>
      )}

      {/* Assignment Set Bundler */}
      {items.length > 0 && (
        <div className={`mt-5 space-y-4 ${card}`}>
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-edge/60 pb-3">
            <label className="flex flex-col gap-1 text-label text-ink-dim">
              Class code
              <input
                type="text"
                value={code}
                onChange={(e) => { setCode(e.target.value); }}
                placeholder="e.g. CS564"
                className={`${inputField} w-48`}
              />
            </label>
            <p className="pb-1 text-label text-ink-dim">
              {items.length} assignment{items.length === 1 ? '' : 's'} in this set
            </p>
          </div>

          <ol className="space-y-2">
            {items.map((item, i) => (
              <li
                key={`${String(i)}-${item.link}`}
                className="flex items-center gap-2 rounded-lg border border-edge bg-surface-3/70 px-3 py-2 text-label shadow-neu-rest"
              >
                <span className="font-mono text-[11px] text-ink-dim tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-ink">
                  {item.label.trim() || `Assignment ${String(i + 1)}`}
                </span>
                <button
                  type="button"
                  onClick={() => { setItems((prev) => prev.filter((_, j) => j !== i)); }}
                  aria-label={`Remove assignment ${String(i + 1)}`}
                  className="rounded px-1.5 py-0.5 text-ink-dim transition hover:bg-surface-2 hover:text-evict"
                >
                  ×
                </button>
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap gap-2 pt-2">
            <button type="button" onClick={() => { void copySheet(); }} className={btnPrimary}>
              {sheetCopied ? 'Copied' : 'Copy worksheet'}
            </button>
            <button type="button" onClick={downloadSet} className={btnSecondary}>
              Download JSON
            </button>
            <button type="button" onClick={() => { setItems([]); }} className={btnGhost}>
              Clear set
            </button>
          </div>
          <p className="text-label text-ink-dim">
            The worksheet exports clean Markdown — paste directly into your syllabus or LMS.
          </p>
        </div>
      )}
    </div>
  );
}
