import { useEffect, useMemo, useState } from 'react';
import { DEMO_INITIAL_KEYS, LATCH_LIMITS, demoScripts, planLatchCrabbing } from '../../ui/latchCrabbing.ts';
import type { LatchProtocol } from '../../ui/latchCrabbing.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnSecondary, inputField, panelSurface } from '../../ui/primitives.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';

/**
 * The latch-crabbing standalone (plan.md §25.4 F5 `/tools/latch-crabbing`). Its driver, `src/ui/latchCrabbing.ts`,
 * runs the same scripted workload under all three protocols on the real engine B+Tree, so the columns below answer
 * for identical inserts.
 *
 * URL state: `fanout`, `threads`, `ops`, `seed` and `timeline` (which protocol's actions are listed), parsed
 * defensively. A pasted link is a stranger's input.
 */

const DEFAULTS = { fanout: 4, threads: 3, ops: 2, seed: 1, timeline: 'crabbing' as LatchProtocol };
const PROTOCOLS: readonly LatchProtocol[] = ['naive', 'crabbing', 'optimistic'];
const PROTOCOL_NAMES: Record<LatchProtocol, string> = {
  naive: 'Naive latching',
  crabbing: 'Lock crabbing',
  optimistic: 'Optimistic coupling',
};
const RESTART_WORDS = {
  'parent-changed': 'a parent changed under the descent',
  'page-changed': 'the page changed since it was read',
  'page-held': 'the page was held',
} as const;
const MAX_SEED = 999_999;

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

function readInitial() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  return {
    fanout: clampInt(p.get('fanout'), LATCH_LIMITS.minFanout, LATCH_LIMITS.maxFanout, DEFAULTS.fanout),
    threads: clampInt(p.get('threads'), LATCH_LIMITS.minThreads, LATCH_LIMITS.maxThreads, DEFAULTS.threads),
    ops: clampInt(p.get('ops'), LATCH_LIMITS.minOpsPerThread, LATCH_LIMITS.maxOpsPerThread, DEFAULTS.ops),
    seed: clampInt(p.get('seed'), 0, MAX_SEED, DEFAULTS.seed),
    timeline: PROTOCOLS.find((x) => x === p.get('timeline')) ?? DEFAULTS.timeline,
  };
}

const INITIAL = readInitial();

export function LatchCrabbingToolPage() {
  const [fanout, setFanout] = useState(INITIAL.fanout);
  const [threads, setThreads] = useState(INITIAL.threads);
  const [ops, setOps] = useState(INITIAL.ops);
  const [seed, setSeed] = useState(INITIAL.seed);
  const [protocol, setProtocol] = useState<LatchProtocol>(INITIAL.timeline);

  const scripts = useMemo(() => demoScripts(threads, ops, seed), [threads, ops, seed]);
  const naive = useMemo(() => planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, fanout, 'naive'), [scripts, fanout]);
  const crab = useMemo(() => planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, fanout, 'crabbing'), [scripts, fanout]);
  const opt = useMemo(() => planLatchCrabbing(DEMO_INITIAL_KEYS, scripts, fanout, 'optimistic'), [scripts, fanout]);
  const plans = [naive, crab, opt] as const;
  const shown = plans.find((p) => p.protocol === protocol) ?? crab;

  useEffect(() => {
    const t = window.setTimeout(() => {
      const p = new URLSearchParams();
      p.set('fanout', String(fanout));
      p.set('threads', String(threads));
      p.set('ops', String(ops));
      p.set('seed', String(seed));
      p.set('timeline', protocol);
      const next = `${location.pathname}?${p.toString()}`;
      if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
    }, 250);
    return () => { window.clearTimeout(t); };
  }, [fanout, threads, ops, seed, protocol]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Latch crabbing">
        Concurrent inserts into one B+Tree, latched page by page. Naive latching holds every page on the path until
        the leaf is written, so every thread funnels through the root. Crabbing releases each ancestor as soon as the
        child below it is safe, so a thread holds only the pages it is changing. Optimistic coupling latches nothing
        on the way down — it reads each page and checks its version — and latches only what it will change, at the
        price of starting again when another thread got there first.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Fanout
          <select value={fanout} onChange={(e) => { setFanout(Number(e.target.value)); }} className={inputField}>
            {Array.from({ length: LATCH_LIMITS.maxFanout - LATCH_LIMITS.minFanout + 1 }, (_, i) => LATCH_LIMITS.minFanout + i).map(
              (v) => <option key={v} value={v}>{v}</option>,
            )}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Threads
          <select value={threads} onChange={(e) => { setThreads(Number(e.target.value)); }} className={inputField}>
            {Array.from({ length: LATCH_LIMITS.maxThreads - LATCH_LIMITS.minThreads + 1 }, (_, i) => LATCH_LIMITS.minThreads + i).map(
              (v) => <option key={v} value={v}>{v}</option>,
            )}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Inserts per thread
          <select value={ops} onChange={(e) => { setOps(Number(e.target.value)); }} className={inputField}>
            {Array.from({ length: LATCH_LIMITS.maxOpsPerThread - LATCH_LIMITS.minOpsPerThread + 1 }, (_, i) => LATCH_LIMITS.minOpsPerThread + i).map(
              (v) => <option key={v} value={v}>{v}</option>,
            )}
          </select>
        </label>
        <button type="button" onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); }} className={btnSecondary}>
          Reshuffle
        </button>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {plans.map((plan) => (
          <div key={plan.protocol} className="flex min-w-0 flex-1 flex-col gap-2">
            <h3 className="text-body font-semibold text-ink">{PROTOCOL_NAMES[plan.protocol]}</h3>
            <dl className={`${panelSurface} grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 p-3 text-label`}>
              <dt className="text-ink-dim">ticks to finish</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{plan.ticks}</dd>
              <dt className="text-ink-dim">ticks spent blocked</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{plan.totalBlockedTicks}</dd>
              <dt className="text-ink-dim">inserts restarted</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{plan.totalRestarts}</dd>
              <dt className="text-ink-dim">most latches one thread holds</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{Math.max(...plan.threads.map((t) => t.peakLatches))}</dd>
              <dt className="text-ink-dim">most latches held across threads</dt>
              <dd className="text-right font-mono tabular-nums text-ink">{plan.maxConcurrentLatches}</dd>
            </dl>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Protocol">
        {PROTOCOLS.map((p) => (
          <button
            key={p}
            type="button"
            role="radio"
            aria-checked={protocol === p}
            onClick={() => { setProtocol(p); }}
            className={`rounded-lg border px-3 py-1.5 text-body transition ${
              protocol === p ? 'border-accent bg-accent/15 text-ink' : 'border-edge bg-surface-3 text-ink-dim hover:border-ink-dim/50'
            }`}
          >
            {p === 'naive' ? 'Naive' : p === 'crabbing' ? 'Crabbing' : 'Optimistic'} timeline
          </button>
        ))}
      </div>

      <div className={`${panelSurface} p-3`}>
        <ScrollRegion label="Latch actions, in tick order" className="overflow-x-auto">
        <table className="w-full text-label">
          <thead>
            <tr className="text-left text-ink-dim">
              <th className="pb-2 font-medium">Tick</th>
              <th className="pb-2 font-medium">Thread</th>
              <th className="pb-2 font-medium">Action</th>
              <th className="pb-2 font-medium">Page</th>
              <th className="pb-2 font-medium">Key</th>
            </tr>
          </thead>
          <tbody>
            {shown.timeline.slice(0, 60).map((a, i) => (
              <tr key={`${String(a.tick)}-${String(i)}`} className="border-t border-edge/60">
                <td className="py-1 font-mono tabular-nums text-ink">{a.tick}</td>
                <td className="py-1 font-mono text-ink">T{a.thread + 1}</td>
                <td className={`py-1 ${a.kind === 'blocked' ? 'text-evict' : a.kind === 'restart' ? 'text-miss' : 'text-ink'}`}>
                  {a.kind}
                  {a.reason !== undefined && <span className="text-ink-dim"> — {RESTART_WORDS[a.reason]}</span>}
                </td>
                <td className="py-1 font-mono text-ink-dim">{a.nodeId ?? '—'}</td>
                <td className="py-1 font-mono tabular-nums text-ink-dim">{a.key}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </ScrollRegion>
        {shown.timeline.length > 60 && (
          <p className="pt-2 text-label text-ink-dim">Showing the first 60 of {shown.timeline.length} actions.</p>
        )}
      </div>

      <p className="text-label leading-relaxed text-ink-dim">
        Threads take turns, one latch action per tick, in a fixed order, so every run is reproducible. A thread that
        asks for a page another thread holds is marked <span className="text-evict">blocked</span> for that tick. An
        optimistic insert <em>reads</em> pages without latching them and <span className="text-miss">restarts</span>{' '}
        from the root when a check fails: a page it read has been changed, or the page it wants to latch is held — it
        does not wait there, but its next read of that page waits for the holder. The tree itself is the engine&rsquo;s own B+Tree, and the final shape is checked by its own validator after every
        run. The paths each insert takes are those of one serial order of the same inserts, so a real concurrent run
        could route them slightly differently.
      </p>
    </div>
  );
}
