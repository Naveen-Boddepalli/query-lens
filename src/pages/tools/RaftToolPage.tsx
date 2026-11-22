import { useEffect, useMemo, useRef, useState } from 'react';
import { electionSafety, leaderCompleteness, logAt, logMatching, stateMachineSafety } from '../../engine/raft.ts';
import type { RaftEvent, RaftResult, Role } from '../../engine/raft.ts';
import { DataTable } from '../../ui/DataView.tsx';
import { btnGhost, inputField } from '../../ui/primitives.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import { usePlayback } from '../../ui/usePlayback.ts';
import { DROP_RATES, RAFT_LINK_LIMITS, RAFT_SCENARIOS, raftHref, readRaftSettings } from '../../ui/raftLinks.ts';
import type { RaftSettings } from '../../ui/raftLinks.ts';
import { raftRun } from '../../ui/raftRun.ts';
import {
  ControlGroup,
  ControlRow,
  hintIdFor,
  Inspector,
  MetricStrip,
  ScenarioPicker,
  Segmented,
  StagePanel,
  Stepper,
  Switch,
  ToolHeader,
  ToolSection,
  ToolShell,
  Transport,
} from '../../ui/tool/index.ts';
import type { Phase } from '../../ui/tool/index.ts';

/**
 * The Raft standalone (plan.md §27.5 X3): leader election and log replication over a schedule you script — a seed for
 * the timeouts and delays, lost messages, a partition and a crash. `engine/raft.ts` is the model; this page draws each
 * server's role over time, every log at a tick you choose, and Raft's four safety properties checked on the run.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): the scenario, the cluster and the failures in the inspector, the
 * timeline as the stage with the logs at the playhead under it, and one transport over the run's ticks in place of
 * the old detached "logs at tick" slider. Dragging or clicking the timeline scrubs too. On a phone the timeline keeps
 * a readable scale and pans, rather than shrinking to fit the screen.
 */

const INITIAL = readRaftSettings(typeof location === 'undefined' ? '' : location.search);
const ROLE_FILL: Record<Role | 'down', string> = { follower: 'fill-surface-4', candidate: 'fill-miss/70', leader: 'fill-accent/80', down: 'fill-evict/25' };
const ROLE_SWATCH: readonly { role: string; bg: string }[] = [
  { role: 'follower', bg: 'bg-surface-4' },
  { role: 'candidate', bg: 'bg-miss/70' },
  { role: 'leader', bg: 'bg-accent/80' },
  { role: 'down', bg: 'bg-evict/25' },
];
const TERM_BG = ['bg-hue-sky/40', 'bg-hue-violet/40', 'bg-hue-amber/40', 'bg-hue-emerald/40', 'bg-hue-orange/40', 'bg-accent-soft'];

/** One line on what each scenario shows, for the picker. */
const BLURBS: Record<string, string> = {
  calm: 'Five servers and nothing goes wrong: one election, then every command replicated and committed.',
  'leader-crash': 'The first leader, S2, is down from tick 50 to 90. The others elect a new leader, and S2 rejoins as a follower.',
  'minority-leader': 'S1 and S2, the leader, are cut off from tick 40 to 90 while commands arrive. What the old leader took never commits.',
  lossy: 'Three messages in ten go missing. Elections and replication take longer, and the logs still agree.',
  three: 'The calm run on three servers, where a majority is two.',
};
const SCENARIOS = RAFT_SCENARIOS.map((sc) => ({ id: sc.id, title: sc.label, blurb: BLURBS[sc.id] ?? '' }));

/**
 * How long playback lingers on a tick, as a multiple of the base step: an election or a crash holds the eye, a tick
 * where nothing happens flicks past, so the calm run plays in about twenty seconds at 1×.
 */
const DWELL: Record<RaftEvent['kind'], number> = {
  elected: 2.5, crash: 2.5, recover: 2, truncate: 2.5, 'step-down': 1.5, timeout: 0.8, commit: 0.5, append: 0.3, client: 0.3,
};
const IDLE_DWELL = 0.08;

/** Two settings are the same run when they make the same link: unused partition and crash ticks don't count. */
const sameRun = (a: RaftSettings, b: RaftSettings) => raftHref(a) === raftHref(b);

/**
 * A whole-number field that applies on Enter or blur (§4.2), so typing "90" does not run the model at "9" on the way.
 * Keyed by its value, so a scenario that changes it resets what is typed.
 */
function NumberField({ id, value, min, max, onCommit, label, className = 'w-20' }: {
  id?: string; value: number; min: number; max: number; onCommit: (v: number) => void; label?: string; className?: string;
}) {
  const commit = (el: HTMLInputElement) => {
    const v = Number(el.value);
    if (el.value.trim() !== '' && Number.isInteger(v)) {
      const clamped = Math.min(max, Math.max(min, v));
      if (clamped !== value) onCommit(clamped);
      el.value = String(clamped);
    } else {
      el.value = String(value);
    }
  };
  return (
    <input
      key={value}
      id={id}
      type="number"
      min={min}
      max={max}
      defaultValue={value}
      aria-label={label}
      onBlur={(e) => { commit(e.currentTarget); }}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget); }}
      className={`${inputField} ${className} tabular-nums`}
    />
  );
}

/** Each server's role over the run. Click, or drag with a mouse, to move the playhead; a touch drag pans instead. */
function Lanes({ r, tick, onTick }: { r: RaftResult; tick: number; onTick: (t: number) => void }) {
  const W = 760;
  const LANE = 28;
  const x = (t: number) => 40 + (t / r.horizon) * (W - 50);
  const dragging = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const lastTick = useRef(tick);
  // Where the timeline pans (a phone), keep the playhead in view as it moves: playing, stepping or scrubbing would
  // otherwise run it off the edge. Not on first paint, which shows the run from its start.
  useEffect(() => {
    if (lastTick.current === tick) return;
    lastTick.current = tick;
    const svg = svgRef.current;
    const pane = svg?.parentElement;
    if (!svg || !pane || pane.scrollWidth <= pane.clientWidth) return;
    const px = (x(tick) / W) * svg.clientWidth;
    const margin = 48;
    if (px < pane.scrollLeft + margin || px > pane.scrollLeft + pane.clientWidth - margin) {
      pane.scrollLeft = Math.max(0, px - pane.clientWidth / 2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `x` is a pure function of `r`, which a tick change follows
  }, [tick]);
  const tickAt = (svg: SVGSVGElement, clientX: number) => {
    const box = svg.getBoundingClientRect();
    const t = Math.round((((clientX - box.left) / box.width) * W - 40) / (W - 50) * r.horizon);
    return Math.max(0, Math.min(r.horizon, t));
  };
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${String(W)} ${String(r.servers * LANE + 22)}`}
      className="h-auto w-full min-w-[44rem] cursor-col-resize select-none"
      role="img"
      aria-label={`Each server's role over ${String(r.horizon)} ticks: ${String(r.leaders.length)} leader${r.leaders.length === 1 ? '' : 's'} elected. The line marks tick ${String(tick)}.`}
      onClick={(e) => { onTick(tickAt(e.currentTarget, e.clientX)); }}
      onPointerDown={(e) => {
        if (e.pointerType !== 'mouse' || e.button !== 0) return;
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => { if (dragging.current) onTick(tickAt(e.currentTarget, e.clientX)); }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
    >
      {Array.from({ length: r.servers }, (_, i) => (
        <text key={i} x={4} y={i * LANE + 19} className="fill-current font-mono text-[11px] text-ink-dim">
          S{i + 1}
        </text>
      ))}
      {r.roles.map((span, i) => (
        <g key={i}>
          <rect x={x(span.from)} y={(span.server - 1) * LANE + 6} width={Math.max(0.5, x(span.to) - x(span.from))} height={18} className={ROLE_FILL[span.role]} />
          {span.role !== 'down' && x(span.to) - x(span.from) > 22 && (
            <text x={x(span.from) + 3} y={(span.server - 1) * LANE + 19} className="fill-current font-mono text-[9px] text-ink">
              T{span.term}
            </text>
          )}
        </g>
      ))}
      <line x1={x(tick)} x2={x(tick)} y1={0} y2={r.servers * LANE + 6} className="stroke-ink" strokeWidth={1.5} />
      {[0, 30, 60, 90, 120, 150].filter((t) => t <= r.horizon).map((t) => (
        <text key={t} x={x(t)} y={r.servers * LANE + 18} textAnchor={t === 0 ? 'start' : 'middle'} className="fill-current text-[10px] text-ink-dim">
          {t}
        </text>
      ))}
    </svg>
  );
}

/** What each colour on the timeline means. */
function RoleKey({ className }: { className: string }) {
  return (
    <span className={`flex-wrap items-center gap-x-3 gap-y-1 ${className}`}>
      {ROLE_SWATCH.map((sw) => (
        <span key={sw.role} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${sw.bg}`} />
          {sw.role}
        </span>
      ))}
    </span>
  );
}

/** What happened at the playhead, as the narration line: this tick's events, or the last one before it. */
function narrate(r: RaftResult, tick: number): string {
  const here = r.events.filter((e) => e.t === tick);
  if (here.length > 0) {
    const shown = here.slice(0, 3).map((e) => e.text).join('; ');
    return `Tick ${String(tick)}: ${shown}${here.length > 3 ? `; and ${String(here.length - 3)} more` : ''}.`;
  }
  const last = r.events.filter((e) => e.t < tick).at(-1);
  if (!last) return `Tick ${String(tick)}: every server is a follower, waiting to hear from a leader.`;
  return `Tick ${String(tick)}. Last thing that happened, at tick ${String(last.t)}: ${last.text}.`;
}

export function RaftToolPage() {
  const [s, setS] = useState<RaftSettings>(INITIAL);
  const [view, setView] = useState<'diagram' | 'table'>('diagram');
  const set = (over: Partial<RaftSettings>) => { setS((cur) => ({ ...cur, ...over })); };
  const r = useMemo(() => raftRun(s), [s]);
  useAddressBarQuery(raftHref(s).split('?')[1] ?? '');

  // Playback over ticks, opening on the finished run (§15.1: start on a real trace, not an empty one).
  const dwells = useMemo(() => {
    const out = Array.from({ length: r.horizon }, () => IDLE_DWELL);
    for (const e of r.events) {
      const i = e.t - 1; // dwells[i] is the pause on tick i + 1
      if (i >= 0 && i < out.length) out[i] = Math.max(out[i] ?? 0, DWELL[e.kind]);
    }
    return out;
  }, [r]);
  const playback = usePlayback(r.horizon, { initialStep: r.horizon, dwells });
  const tick = playback.step;

  const checks = useMemo(
    () => [
      { name: 'Election safety', ok: electionSafety(r), says: 'at most one leader in any term' },
      { name: 'Log matching', ok: logMatching(r), says: 'two logs with an entry of the same index and term agree on everything up to it' },
      { name: 'Leader completeness', ok: leaderCompleteness(r), says: 'every committed entry is in the log of every later leader' },
      { name: 'State machine safety', ok: stateMachineSafety(r), says: 'no two servers apply different entries at the same index' },
    ],
    [r],
  );
  const holding = checks.filter((c) => c.ok).length;
  const committed = Math.max(0, ...r.final.map((f) => f.commitIndex));
  const truncated = r.events.filter((e) => e.kind === 'truncate').length;
  const rows = r.events.map((e) => ({ t: e.t, server: `S${String(e.server)}`, term: e.term, what: e.text }));

  // The readout follows the playhead. Spans run [from, to); the last tick belongs to the span that ends there.
  const at = Math.min(tick, r.horizon - 0.5);
  // Two servers can both think they lead (an old leader cut off in a minority): the newest term is the real one.
  const leadersNow = r.roles.filter((sp) => sp.role === 'leader' && sp.from <= at && at < sp.to).sort((a, b) => b.term - a.term);
  const leaderNow = leadersNow[0];
  const staleNow = leadersNow.slice(1).map((sp) => `S${String(sp.server)} still leads T${String(sp.term)}`);
  const commitNow = Math.max(0, ...r.snapshots.filter((x) => x.t <= tick).map((x) => x.commitIndex));

  const phases = useMemo<Phase[]>(() => {
    const out: Phase[] = r.leaders.map((l) => ({ label: `S${String(l.server)} leads T${String(l.term)}`, step: l.at }));
    if (s.side !== '') out.push({ label: 'Cut off', step: s.partitionFrom }, { label: 'Healed', step: s.partitionTo });
    if (s.crash !== 0) out.push({ label: `S${String(s.crash)} down`, step: s.crashFrom }, { label: `S${String(s.crash)} up`, step: s.crashTo });
    return out.filter((p) => p.step <= r.horizon).sort((a, b) => a.step - b.step);
  }, [r, s.side, s.partitionFrom, s.partitionTo, s.crash, s.crashFrom, s.crashTo]);

  const scenario = RAFT_SCENARIOS.find((sc) => sameRun(sc.settings, s));
  const failures = [s.drop > 0 ? `${String(s.drop)}% loss` : '', s.side !== '' ? 'partition' : '', s.crash !== 0 ? 'crash' : ''].filter(Boolean);
  const serverIds = Array.from({ length: s.servers }, (_, i) => String(i + 1));

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="distributed"
        header={
          <ToolHeader
            id="raft"
            title="Raft"
            summary="Watch servers elect a leader and replicate one log while messages go missing and machines crash."
            about={
              <>
                <p>
                  Servers elect a <strong>leader</strong> for a numbered <strong>term</strong>. The leader appends each
                  command to its log and copies it to the others, and an entry is <strong>committed</strong> once a
                  majority holds it. A server votes only for a candidate whose log is at least as up to date as its own,
                  which is what keeps a committed entry from ever being lost.
                </p>
                <p>
                  Everything runs to a script: a seed draws the timeouts and delays, and you choose the losses, the
                  partition and the crash. Not modelled: membership changes, snapshots, and client sessions.
                </p>
              </>
            }
          />
        }
        inspector={
          <Inspector summary={`${String(s.servers)} servers · ${failures.length > 0 ? failures.join(' · ') : 'no failures'}`}>
            <ScenarioPicker
              id="raft-scenario"
              scenarios={SCENARIOS}
              value={scenario?.id ?? null}
              onPick={(id) => {
                const picked = RAFT_SCENARIOS.find((sc) => sc.id === id);
                if (picked) setS(picked.settings);
              }}
            />
            <ControlGroup legend="Cluster">
              <ControlRow label="Servers" labelId="raft-servers">
                <Segmented
                  labelledBy="raft-servers"
                  tone="stage"
                  value={String(s.servers) as '3' | '5'}
                  onChange={(v) => {
                    const k = v === '3' ? 3 : 5;
                    set({ servers: k, side: [...s.side].filter((c) => Number(c) <= k).join(''), crash: s.crash > k ? 0 : s.crash });
                  }}
                  options={[{ value: '3', label: '3' }, { value: '5', label: '5' }]}
                />
              </ControlRow>
              <ControlRow label="Client commands" htmlFor="raft-commands" hint="One every five ticks, from tick 30.">
                <Stepper
                  id="raft-commands"
                  value={s.commands}
                  min={0}
                  max={RAFT_LINK_LIMITS.maxCommands}
                  unit="commands"
                  describedBy={hintIdFor('raft-commands')}
                  onChange={(v) => { set({ commands: v }); }}
                />
              </ControlRow>
              <Switch
                id="raft-noop"
                checked={s.noOp}
                onChange={(on) => { set({ noOp: on }); }}
                label="A new leader appends a no-op"
                describedBy="raft-noop-hint"
              />
              <p id="raft-noop-hint" className="text-label text-ink-dim">
                An empty entry of its own term, so it can commit what earlier terms left behind.
              </p>
            </ControlGroup>
            <ControlGroup legend="Failures">
              <ControlRow label="Messages lost" labelId="raft-drop" stacked>
                <Segmented
                  labelledBy="raft-drop"
                  tone="stage"
                  value={String(s.drop)}
                  onChange={(v) => { set({ drop: Number(v) }); }}
                  options={DROP_RATES.map((d) => ({ value: String(d), label: `${String(d)}%` }))}
                />
              </ControlRow>
              <ControlRow label="Cut off from the rest" labelId="raft-side" stacked hint="Fewer than all of them.">
                <div role="group" aria-labelledby="raft-side" aria-describedby={hintIdFor('raft-side')} className="flex flex-wrap gap-1">
                  {serverIds.map((id) => {
                    const on = s.side.includes(id);
                    const next = [...new Set(on ? [...s.side].filter((c) => c !== id) : [...s.side, id])].sort().join('');
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={on}
                        disabled={!on && next.length >= s.servers}
                        onClick={() => { set({ side: next }); }}
                        className={`rounded-full border px-2.5 py-0.5 font-mono text-label transition duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40 ${
                          on ? 'ql-stage-chip-current text-ink' : 'border-edge text-ink-dim hover:text-ink'
                        }`}
                      >
                        S{id}
                      </button>
                    );
                  })}
                </div>
              </ControlRow>
              {s.side !== '' && (
                <ControlRow label="Cut off during" htmlFor="raft-pf" stacked>
                  <span className="flex items-center gap-1.5 text-label text-ink-dim">
                    <NumberField id="raft-pf" label="Cut off from tick" value={s.partitionFrom} min={0} max={RAFT_LINK_LIMITS.maxTick - 1} onCommit={(v) => { set({ partitionFrom: v, partitionTo: Math.max(v + 1, s.partitionTo) }); }} />
                    to
                    <NumberField label="Healed at tick" value={s.partitionTo} min={s.partitionFrom + 1} max={RAFT_LINK_LIMITS.maxTick} onCommit={(v) => { set({ partitionTo: v }); }} />
                  </span>
                </ControlRow>
              )}
              <ControlRow label="A server crashes" htmlFor="raft-crash">
                <select id="raft-crash" value={s.crash} onChange={(e) => { set({ crash: Number(e.target.value) }); }} className={inputField}>
                  <option value={0}>none</option>
                  {serverIds.map((id) => (
                    <option key={id} value={Number(id)}>
                      S{id}
                    </option>
                  ))}
                </select>
              </ControlRow>
              {s.crash !== 0 && (
                <ControlRow label="Down during" htmlFor="raft-cf" stacked>
                  <span className="flex items-center gap-1.5 text-label text-ink-dim">
                    <NumberField id="raft-cf" label="Down from tick" value={s.crashFrom} min={0} max={RAFT_LINK_LIMITS.maxTick - 1} onCommit={(v) => { set({ crashFrom: v, crashTo: Math.max(v + 1, s.crashTo) }); }} />
                    to
                    <NumberField label="Up at tick" value={s.crashTo} min={s.crashFrom + 1} max={RAFT_LINK_LIMITS.maxTick} onCommit={(v) => { set({ crashTo: v }); }} />
                  </span>
                </ControlRow>
              )}
            </ControlGroup>
            <ControlGroup legend="Advanced" advanced defaultOpen={s.seed !== RAFT_SCENARIOS[0]?.settings.seed}>
              <ControlRow label="Seed" htmlFor="raft-seed" hint="Draws the timeouts and delays: the same seed, the same run.">
                <span className="flex items-center gap-1">
                  <NumberField id="raft-seed" value={s.seed} min={0} max={RAFT_LINK_LIMITS.maxSeed} onCommit={(v) => { set({ seed: v }); }} className="w-24" />
                  <button
                    type="button"
                    className={`${btnGhost} px-2!`}
                    aria-label="Draw a new seed"
                    onClick={() => { set({ seed: Math.floor(Math.random() * RAFT_LINK_LIMITS.maxSeed) }); }}
                  >
                    ↻
                  </button>
                </span>
              </ControlRow>
            </ControlGroup>
          </Inspector>
        }
        metrics={
          <MetricStrip
            items={[
              { label: `Leader at tick ${String(tick)}`, value: leaderNow ? `S${String(leaderNow.server)}` : 'none', sub: leaderNow ? [`term ${String(leaderNow.term)}`, ...staleNow].join('; ') : 'no one leads' },
              { label: 'Committed', value: commitNow === 0 ? 'nothing' : `entry ${String(commitNow)}`, sub: 'held by a majority' },
              { label: 'Leaders elected', value: r.leaders.length, sub: truncated > 0 ? `${String(truncated)} rollback${truncated === 1 ? '' : 's'}` : `over ${String(r.horizon)} ticks` },
              { label: 'Safety', value: `${String(holding)}/${String(checks.length)} hold`, tone: holding === checks.length ? 'hit' : 'evict' },
            ]}
          />
        }
        stage={
          <StagePanel
            title="Timeline"
            legend={<RoleKey className="hidden sm:flex" />}
            views={[{ value: 'diagram', label: 'Diagram' }, { value: 'table', label: 'Table' }]}
            view={view}
            onView={setView}
          >
            {view === 'diagram' ? (
              <>
                {/* On a phone the header has no room beside the view switch: the key sits over the lanes instead. */}
                <RoleKey className="mb-2 flex text-label text-ink-dim sm:hidden" />
                <ScrollRegion label="Each server's role over time" className="overflow-x-auto">
                  <Lanes r={r} tick={tick} onTick={playback.seek} />
                </ScrollRegion>
              </>
            ) : (
              <DataTable
                caption="Every election, commit, crash and dropped entry, in order"
                rows={rows}
                keyOf={(row, i) => `${String(i)}-${String(row.t)}`}
                columns={[
                  { header: 'Tick', cell: (row) => row.t },
                  { header: 'Server', cell: (row) => row.server },
                  { header: 'Term', cell: (row) => row.term },
                  { header: 'What', cell: (row) => row.what },
                ]}
              />
            )}
            <p className="mt-2 text-label text-ink-dim">
              {r.leaders.length === 0
                ? 'No leader was elected'
                : `${String(r.leaders.length)} leader${r.leaders.length === 1 ? '' : 's'}: ${r.leaders.map((l) => `S${String(l.server)} for term ${String(l.term)} at tick ${String(l.at)}`).join(', ')}`}
              . Committed through entry {committed}
              {truncated > 0 ? `; ${String(truncated)} time${truncated === 1 ? '' : 's'} a server dropped entries that conflicted with a leader’s` : ''}
              {r.unheard.length > 0 ? `; ${String(r.unheard.length)} command${r.unheard.length === 1 ? '' : 's'} found no leader` : ''}.
            </p>

            <div className="mt-4 flex flex-col gap-2 border-t border-edge/60 pt-3">
              <h4 className="text-label font-semibold text-ink">Logs at tick {tick}</h4>
              <ul className="flex flex-col gap-1.5">
                {Array.from({ length: r.servers }, (_, i) => {
                  const server = i + 1;
                  const log = logAt(r, server, tick);
                  const commit = r.snapshots.filter((x) => x.server === server && x.t <= tick).at(-1)?.commitIndex ?? 0;
                  return (
                    <li key={server} className="flex items-start gap-2">
                      <span className="w-8 shrink-0 font-mono text-label text-ink-dim">S{server}</span>
                      <span className="flex min-w-0 flex-wrap gap-1" aria-label={`S${String(server)}'s log at tick ${String(tick)}: ${String(log.length)} entries, committed through ${String(commit)}`}>
                        {log.length === 0 && <span className="text-label text-ink-dim">(empty)</span>}
                        {log.map((e, k) => (
                          <span
                            key={k}
                            className={`rounded px-1 font-mono text-[11px] ${TERM_BG[(e.term - 1) % TERM_BG.length]!} ${k < commit ? 'text-ink' : 'border border-dashed border-ink-dim text-ink-dim'}`}
                            title={`entry ${String(k + 1)}, term ${String(e.term)}${k < commit ? ', committed' : ', not committed here'}`}
                          >
                            {k + 1}·T{e.term} {e.command}
                          </span>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="text-label text-ink-dim">
                Each entry shows its index, its term and its command, coloured by term; dashed is not yet committed on
                that server.
              </p>
            </div>
          </StagePanel>
        }
        narration={narrate(r, tick)}
        transport={<Transport playback={playback} length={r.horizon} phases={phases} unit="tick" />}
      >
        <ToolSection title="Safety, checked on this run" description="Raft's four guarantees, tested against every server's log.">
          <ul className="grid gap-1 text-label sm:grid-cols-2">
            {checks.map((c) => (
              <li key={c.name} className={c.ok ? 'text-ink' : 'text-evict'}>
                {c.ok ? '✓' : '✗'} <strong>{c.name}</strong> — {c.says}
              </li>
            ))}
          </ul>
        </ToolSection>
      </ToolShell>
    </div>
  );
}
