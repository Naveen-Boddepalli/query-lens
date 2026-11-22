import { useMemo, useState } from 'react';
import { DEMO_INITIAL_KEYS, LATCH_LIMITS, demoScripts, planLatchCrabbing } from '../../ui/latchCrabbing.ts';
import type { LatchProtocol } from '../../ui/latchCrabbing.ts';
import { btnGhost } from '../../ui/primitives.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  ControlGroup,
  ControlRow,
  hintIdFor,
  Inspector,
  MetricStrip,
  Segmented,
  StagePanel,
  Stepper,
  ToolHeader,
  ToolSection,
  ToolShell,
} from '../../ui/tool/index.ts';

/**
 * The latch-crabbing standalone (plan.md §25.4 F5 `/tools/latch-crabbing`). Its driver, `src/ui/latchCrabbing.ts`,
 * runs the same scripted workload under all three protocols on the real engine B+Tree, so the columns below answer
 * for identical inserts.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): the workload in the inspector, the chosen protocol's counts in the
 * readout, its latch timeline on the stage (the protocol switch in the stage header), and all three protocols side
 * by side below.
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
const SHORT_NAMES: Record<LatchProtocol, string> = { naive: 'Naive', crabbing: 'Crabbing', optimistic: 'Optimistic' };
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

  const shareQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('fanout', String(fanout));
    p.set('threads', String(threads));
    p.set('ops', String(ops));
    p.set('seed', String(seed));
    p.set('timeline', protocol);
    return p.toString();
  }, [fanout, threads, ops, seed, protocol]);
  useAddressBarQuery(shareQuery);

  const peakOne = (plan: (typeof plans)[number]) => Math.max(...plan.threads.map((t) => t.peakLatches));
  const summary = (plan: (typeof plans)[number]) =>
    `${PROTOCOL_NAMES[plan.protocol].toLowerCase()} ${String(plan.ticks)} with ${String(plan.totalBlockedTicks)} blocked${plan.totalRestarts > 0 ? ` and ${plural(plan.totalRestarts, 'restart')}` : ''}`;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="indexing"
        header={
          <ToolHeader
            id="latch-crabbing"
            title="Latch crabbing"
            summary="Run the same concurrent inserts into one B+Tree under three latching protocols, and count the ticks each spends blocked."
            about={
              <>
                <p>
                  Concurrent inserts into one B+Tree, latched page by page. Naive latching holds every page on the path
                  until the leaf is written, so every thread funnels through the root. Crabbing releases each ancestor as
                  soon as the child below it is safe, so a thread holds only the pages it is changing. Optimistic
                  coupling latches nothing on the way down (it reads each page and checks its version) and latches only
                  what it will change, at the price of starting again when another thread got there first.
                </p>
                <p>
                  Threads take turns, one latch action per tick, in a fixed order, so every run is reproducible. A thread
                  that asks for a page another thread holds is marked <span className="text-evict">blocked</span> for
                  that tick. An optimistic insert <em>reads</em> pages without latching them and{' '}
                  <span className="text-miss">restarts</span> from the root when a check fails: a page it read has been
                  changed, or the page it wants to latch is held. It does not wait there, but its next read of that page
                  waits for the holder. The tree itself is the engine&rsquo;s own B+Tree, and the final shape is checked
                  by its own validator after every run. The paths each insert takes are those of one serial order of the
                  same inserts, so a real concurrent run could route them slightly differently.
                </p>
              </>
            }
          />
        }
        inspector={
          <Inspector summary={`fanout ${String(fanout)} · ${plural(threads, 'thread')} · ${String(ops)} each`}>
            <ControlGroup legend="Workload">
              <ControlRow label="Fanout" htmlFor="latch-fanout" hint="Keys a page holds before it splits.">
                <Stepper id="latch-fanout" value={fanout} min={LATCH_LIMITS.minFanout} max={LATCH_LIMITS.maxFanout} unit="keys" describedBy={hintIdFor('latch-fanout')} onChange={setFanout} />
              </ControlRow>
              <ControlRow label="Threads" htmlFor="latch-threads">
                <Stepper id="latch-threads" value={threads} min={LATCH_LIMITS.minThreads} max={LATCH_LIMITS.maxThreads} unit="threads" onChange={setThreads} />
              </ControlRow>
              <ControlRow label="Inserts per thread" htmlFor="latch-ops">
                <Stepper id="latch-ops" value={ops} min={LATCH_LIMITS.minOpsPerThread} max={LATCH_LIMITS.maxOpsPerThread} unit="inserts" onChange={setOps} />
              </ControlRow>
              <button type="button" onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); }} className={`${btnGhost} self-start`}>
                Shuffle the keys
              </button>
            </ControlGroup>
          </Inspector>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Ticks to finish', value: shown.ticks, sub: PROTOCOL_NAMES[shown.protocol] },
              { label: 'Ticks blocked', value: shown.totalBlockedTicks, sub: 'summed over threads', ...(shown.totalBlockedTicks > 0 ? { tone: 'evict' as const } : {}) },
              { label: 'Inserts restarted', value: shown.totalRestarts, sub: 'optimistic checks that failed', ...(shown.totalRestarts > 0 ? { tone: 'miss' as const } : {}) },
              { label: 'Peak latches', value: shown.maxConcurrentLatches, sub: `across threads; ${String(peakOne(shown))} by one` },
            ]}
          />
        }
        stage={
          <StagePanel
            title="Timeline"
            legend={shown.timeline.length > 60 ? `first 60 of ${String(shown.timeline.length)} latch actions` : `${String(shown.timeline.length)} latch actions`}
            toolbar={
              <Segmented
                label="Protocol"
                size="sm"
                tone="stage"
                value={protocol}
                onChange={setProtocol}
                options={PROTOCOLS.map((p) => ({ value: p, label: SHORT_NAMES[p], ariaLabel: `${SHORT_NAMES[p]} timeline` }))}
              />
            }
          >
            <ScrollRegion label="Latch actions, in tick order" className="max-h-[32rem] overflow-auto">
              <table className="w-full text-label">
                <thead className="sticky top-0 bg-surface-2">
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
                      <td className="py-1 font-mono text-ink tabular-nums">{a.tick}</td>
                      <td className="py-1 font-mono text-ink">T{a.thread + 1}</td>
                      <td className={`py-1 ${a.kind === 'blocked' ? 'text-evict' : a.kind === 'restart' ? 'text-miss' : 'text-ink'}`}>
                        {a.kind}
                        {a.reason !== undefined && <span className="text-ink-dim"> — {RESTART_WORDS[a.reason]}</span>}
                      </td>
                      <td className="py-1 font-mono text-ink-dim">{a.nodeId ?? '—'}</td>
                      <td className="py-1 font-mono text-ink-dim tabular-nums">{a.key}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </StagePanel>
        }
        narration={`Ticks to finish, and ticks blocked: ${plans.map(summary).join('; ')}.`}
      >
        <ToolSection
          title="Three protocols, the same inserts"
          description="Each row is the same scripted workload on the same tree; only the latching changes. Ticks is the time to finish every insert; blocked sums the ticks threads spent waiting. Pick a protocol above to read its timeline."
        >
          <ScrollRegion label="The three protocols compared" className="overflow-x-auto" stickyFirst>
            <table className="w-full text-label">
              <thead>
                <tr className="text-left text-ink-dim">
                  <th className="pr-3 pb-2 font-medium">Protocol</th>
                  <th className="pb-2 pl-4 text-right font-medium whitespace-nowrap">Ticks</th>
                  <th className="pb-2 pl-4 text-right font-medium whitespace-nowrap">Blocked</th>
                  <th className="pb-2 pl-4 text-right font-medium whitespace-nowrap">Restarts</th>
                  <th className="pb-2 pl-4 text-right font-medium whitespace-nowrap">Peak latches, one thread</th>
                  <th className="pb-2 pl-4 text-right font-medium whitespace-nowrap">Peak latches, all threads</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.protocol} className={`border-t border-edge/60 ${plan.protocol === protocol ? 'text-ink' : 'text-ink-dim'}`}>
                    <th scope="row" className="py-1.5 pr-3 text-left font-medium whitespace-nowrap">
                      {PROTOCOL_NAMES[plan.protocol]}
                    </th>
                    <td className="py-1.5 pl-4 text-right font-mono tabular-nums">{plan.ticks}</td>
                    <td className="py-1.5 pl-4 text-right font-mono tabular-nums">{plan.totalBlockedTicks}</td>
                    <td className="py-1.5 pl-4 text-right font-mono tabular-nums">{plan.totalRestarts}</td>
                    <td className="py-1.5 pl-4 text-right font-mono tabular-nums">{peakOne(plan)}</td>
                    <td className="py-1.5 pl-4 text-right font-mono tabular-nums">{plan.maxConcurrentLatches}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </ToolSection>
      </ToolShell>
    </div>
  );
}

const plural = (k: number, s: string) => `${String(k)} ${k === 1 ? s : `${s}s`}`;
