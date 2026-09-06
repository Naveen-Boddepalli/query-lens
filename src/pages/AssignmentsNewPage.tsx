import { useMemo, useState } from 'react';
import {
  createSeedDatabase,
  DEFAULT_ENGINE_OPTIONS,
  runQuery,
} from '../engine/index.ts';
import type { ReplacementPolicyName } from '../engine/index.ts';
import { encodeShareState } from '../ui/urlState.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnPrimary, card, inputField } from '../ui/primitives.ts';

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
  const [copied, setCopied] = useState(false);

  const trace = useMemo(
    () => runQuery(sql, SEED, { ...DEFAULT_ENGINE_OPTIONS, policy }),
    [sql, policy],
  );

  const clampedStep = trace.error ? 0 : Math.max(0, Math.min(step, trace.events.length));

  const link = useMemo(() => {
    if (typeof location === 'undefined' || trace.error) return '';
    const query = encodeShareState(
      { sql, policy, predictOn: true, step: clampedStep },
      undefined,
    );
    return `${location.origin}/playground?${query}`;
  }, [sql, policy, clampedStep, trace.error]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => { setCopied(false); }, 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <PageHeader eyebrow="For instructors" title="Create an assignment">
        Pick a query, a policy and a step, and get a link. Opening it lands the reader on that
        exact step with prediction switched on, so the first thing they do is answer a question
        rather than read background. No account, no submission — the link <em>is</em> the
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
              <option value="lru">LRU</option>
              <option value="clock">Clock sweep</option>
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
      </div>

      {link && (
        <div className="ql-sheen mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
          <code className="min-w-0 flex-1 truncate font-mono text-label text-ink">{link}</code>
          <button type="button" onClick={() => { void copyLink(); }} className={btnPrimary}>
            {copied ? 'Copied ✓' : 'Copy link'}
          </button>
        </div>
      )}
    </div>
  );
}
