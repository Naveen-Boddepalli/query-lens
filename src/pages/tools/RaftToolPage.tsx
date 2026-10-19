import { useMemo, useState } from 'react';
import { electionSafety, leaderCompleteness, logAt, logMatching, stateMachineSafety } from '../../engine/raft.ts';
import type { RaftResult, Role } from '../../engine/raft.ts';
import { DataView } from '../../ui/DataView.tsx';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnSecondary, inputField, panelSurface, segBase, segOff, segOn } from '../../ui/primitives.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import { DROP_RATES, RAFT_LINK_LIMITS, RAFT_SCENARIOS, raftHref, readRaftSettings } from '../../ui/raftLinks.ts';
import type { RaftSettings } from '../../ui/raftLinks.ts';
import { raftRun } from '../../ui/raftRun.ts';

/**
 * The Raft standalone (plan.md §27.5 X3): leader election and log replication over a schedule you script — a seed for
 * the timeouts and delays, lost messages, a partition and a crash. `engine/raft.ts` is the model; this page draws each
 * server's role over time, every log at a tick you choose, and Raft's four safety properties checked on the run.
 */

const INITIAL = readRaftSettings(typeof location === 'undefined' ? '' : location.search);
const ROLE_FILL: Record<Role | 'down', string> = { follower: 'fill-surface-4', candidate: 'fill-miss/70', leader: 'fill-accent/80', down: 'fill-evict/25' };
const TERM_BG = ['bg-hue-sky/40', 'bg-hue-violet/40', 'bg-hue-amber/40', 'bg-hue-emerald/40', 'bg-hue-orange/40', 'bg-accent-soft'];

function Lanes({ r, tick, onTick }: { r: RaftResult; tick: number; onTick: (t: number) => void }) {
  const W = 760;
  const LANE = 28;
  const x = (t: number) => 40 + (t / r.horizon) * (W - 50);
  return (
    <svg
      viewBox={`0 0 ${String(W)} ${String(r.servers * LANE + 22)}`}
      className="h-auto w-full cursor-pointer"
      role="img"
      aria-label={`Each server's role over ${String(r.horizon)} ticks: ${String(r.leaders.length)} leader${r.leaders.length === 1 ? '' : 's'} elected`}
      onClick={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        const t = Math.round((((e.clientX - box.left) / box.width) * W - 40) / (W - 50) * r.horizon);
        onTick(Math.max(0, Math.min(r.horizon, t)));
      }}
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
      <line x1={x(tick)} x2={x(tick)} y1={0} y2={r.servers * LANE + 6} className="stroke-ink" strokeWidth={1.2} />
      {[0, 30, 60, 90, 120, 150].filter((t) => t <= r.horizon).map((t) => (
        <text key={t} x={x(t)} y={r.servers * LANE + 18} textAnchor={t === 0 ? 'start' : 'middle'} className="fill-current text-[10px] text-ink-dim">
          {t}
        </text>
      ))}
    </svg>
  );
}

export function RaftToolPage() {
  const [s, setS] = useState<RaftSettings>(INITIAL);
  const [tick, setTick] = useState<number>(RAFT_LINK_LIMITS.horizon);
  const set = (over: Partial<RaftSettings>) => { setS((cur) => ({ ...cur, ...over })); };
  const r = useMemo(() => raftRun(s), [s]);
  useAddressBarQuery(raftHref(s).split('?')[1] ?? '');

  const checks = useMemo(
    () => [
      { name: 'Election safety', ok: electionSafety(r), says: 'at most one leader in any term' },
      { name: 'Log matching', ok: logMatching(r), says: 'two logs with an entry of the same index and term agree on everything up to it' },
      { name: 'Leader completeness', ok: leaderCompleteness(r), says: 'every committed entry is in the log of every later leader' },
      { name: 'State machine safety', ok: stateMachineSafety(r), says: 'no two servers apply different entries at the same index' },
    ],
    [r],
  );
  const committed = Math.max(0, ...r.final.map((f) => f.commitIndex));
  const truncated = r.events.filter((e) => e.kind === 'truncate').length;
  const rows = r.events.map((e) => ({ t: e.t, server: `S${String(e.server)}`, term: e.term, what: e.text }));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Raft">
        A replicated log that stays one log while machines crash and messages go missing. Servers elect a{' '}
        <strong>leader</strong> for a numbered <strong>term</strong>; the leader appends each command to its log and copies
        it to the others, and an entry is <strong>committed</strong> once a majority holds it. A server votes only for a
        candidate whose log is at least as up to date as its own — which is what keeps a committed entry from ever being
        lost. Everything here runs to a script: a seed draws the timeouts and delays, and you choose the losses, the
        partition and the crash. Not modelled: membership changes, snapshots, and client sessions.
      </PageHeader>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Scenarios">
        {RAFT_SCENARIOS.map((sc) => (
          <button key={sc.id} type="button" onClick={() => { setS(sc.settings); }} className={btnSecondary}>
            {sc.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Servers
          <div className="flex gap-1" role="radiogroup" aria-label="Servers">
            {([3, 5] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={s.servers === k}
                onClick={() => {
                  set({ servers: k, side: [...s.side].filter((c) => Number(c) <= k).join(''), crash: s.crash > k ? 0 : s.crash });
                }}
                className={`${segBase} ${s.servers === k ? segOn : segOff}`}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Seed
          <input
            type="number"
            min={0}
            max={RAFT_LINK_LIMITS.maxSeed}
            value={s.seed}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= 0 && v <= RAFT_LINK_LIMITS.maxSeed) set({ seed: v });
            }}
            className={`${inputField} w-28 tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Messages lost
          <select value={s.drop} onChange={(e) => { set({ drop: Number(e.target.value) }); }} className={inputField}>
            {DROP_RATES.map((d) => (
              <option key={d} value={d}>
                {d}%
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Client commands
          <select value={s.commands} onChange={(e) => { set({ commands: Number(e.target.value) }); }} className={inputField}>
            {Array.from({ length: RAFT_LINK_LIMITS.maxCommands + 1 }, (_, i) => i).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          New leader&rsquo;s no-op
          <div className="flex gap-1" role="radiogroup" aria-label="New leader’s no-op">
            {[true, false].map((on) => (
              <button key={String(on)} type="button" role="radio" aria-checked={s.noOp === on} onClick={() => { set({ noOp: on }); }} className={`${segBase} ${s.noOp === on ? segOn : segOff}`}>
                {on ? 'On' : 'Off'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <fieldset className="flex flex-col gap-1 text-label text-ink-dim">
          <legend>Cut off from the rest</legend>
          <div className="flex gap-2">
            {Array.from({ length: s.servers }, (_, i) => String(i + 1)).map((id) => (
              <label key={id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={s.side.includes(id)}
                  onChange={(e) => {
                    const next = e.target.checked ? [...s.side, id] : [...s.side].filter((c) => c !== id);
                    const side = [...new Set(next)].sort().join('');
                    if (side.length < s.servers) set({ side });
                  }}
                />
                S{id}
              </label>
            ))}
          </div>
        </fieldset>
        {s.side !== '' && (
          <>
            <label className="flex flex-col gap-1 text-label text-ink-dim">
              From tick
              <input type="number" min={0} max={RAFT_LINK_LIMITS.maxTick} value={s.partitionFrom} onChange={(e) => { set({ partitionFrom: Math.max(0, Number(e.target.value) || 0) }); }} className={`${inputField} w-20 tabular-nums`} />
            </label>
            <label className="flex flex-col gap-1 text-label text-ink-dim">
              To tick
              <input type="number" min={1} max={RAFT_LINK_LIMITS.maxTick} value={s.partitionTo} onChange={(e) => { set({ partitionTo: Math.max(s.partitionFrom + 1, Number(e.target.value) || 0) }); }} className={`${inputField} w-20 tabular-nums`} />
            </label>
          </>
        )}
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          A server crashes
          <select value={s.crash} onChange={(e) => { set({ crash: Number(e.target.value) }); }} className={inputField}>
            <option value={0}>none</option>
            {Array.from({ length: s.servers }, (_, i) => i + 1).map((k) => (
              <option key={k} value={k}>
                S{k}
              </option>
            ))}
          </select>
        </label>
        {s.crash !== 0 && (
          <>
            <label className="flex flex-col gap-1 text-label text-ink-dim">
              Down from
              <input type="number" min={0} max={RAFT_LINK_LIMITS.maxTick} value={s.crashFrom} onChange={(e) => { set({ crashFrom: Math.max(0, Number(e.target.value) || 0) }); }} className={`${inputField} w-20 tabular-nums`} />
            </label>
            <label className="flex flex-col gap-1 text-label text-ink-dim">
              Up at
              <input type="number" min={1} max={RAFT_LINK_LIMITS.maxTick} value={s.crashTo} onChange={(e) => { set({ crashTo: Math.max(s.crashFrom + 1, Number(e.target.value) || 0) }); }} className={`${inputField} w-20 tabular-nums`} />
            </label>
          </>
        )}
      </div>

      <div className={`${panelSurface} flex flex-col gap-2 p-4`}>
        <p className="text-body text-ink">
          <span role="status">
            {r.leaders.length === 0
              ? 'No leader was elected'
              : `${String(r.leaders.length)} leader${r.leaders.length === 1 ? '' : 's'}: ${r.leaders.map((l) => `S${String(l.server)} for term ${String(l.term)} at tick ${String(l.at)}`).join(', ')}`}
          </span>
          . Committed through entry {committed}
          {truncated > 0 ? `; ${String(truncated)} time${truncated === 1 ? '' : 's'} a server dropped entries that conflicted with a leader’s` : ''}
          {r.unheard.length > 0 ? `; ${String(r.unheard.length)} command${r.unheard.length === 1 ? '' : 's'} found no leader` : ''}.
        </p>
        <ul className="grid gap-1 text-label sm:grid-cols-2">
          {checks.map((c) => (
            <li key={c.name} className={c.ok ? 'text-ink' : 'text-evict'}>
              {c.ok ? '✓' : '✗'} <strong>{c.name}</strong> — {c.says}
            </li>
          ))}
        </ul>
      </div>

      <DataView
        caption="Every election, commit, crash and dropped entry, in order"
        rows={rows}
        keyOf={(row, i) => `${String(i)}-${String(row.t)}`}
        columns={[
          { header: 'Tick', cell: (row) => row.t },
          { header: 'Server', cell: (row) => row.server },
          { header: 'Term', cell: (row) => row.term },
          { header: 'What', cell: (row) => row.what },
        ]}
      >
        <div className={`${panelSurface} p-4`}>
          <ScrollRegion label="Each server's role over time" className="overflow-x-auto">
            <Lanes r={r} tick={tick} onTick={setTick} />
          </ScrollRegion>
          <p className="mt-1 text-label text-ink-dim">
            Grey a follower, amber a candidate, teal the leader, red down; each band names its term. Click, or use the
            slider below, to see every log at that tick.
          </p>
        </div>
      </DataView>

      <div className={`${panelSurface} flex flex-col gap-2 p-4`}>
        <label className="flex flex-wrap items-center gap-3 text-label text-ink-dim">
          The logs at tick
          <input type="range" min={0} max={r.horizon} value={tick} onChange={(e) => { setTick(Number(e.target.value)); }} className="w-64" />
          <span className="tabular-nums text-ink">{tick}</span>
        </label>
        <ul className="flex flex-col gap-1.5">
          {Array.from({ length: r.servers }, (_, i) => {
            const server = i + 1;
            const log = logAt(r, server, tick);
            const commit = r.snapshots.filter((x) => x.server === server && x.t <= tick).at(-1)?.commitIndex ?? 0;
            return (
              <li key={server} className="flex items-center gap-2">
                <span className="w-8 font-mono text-label text-ink-dim">S{server}</span>
                <span className="flex flex-wrap gap-1" aria-label={`S${String(server)}'s log at tick ${String(tick)}: ${String(log.length)} entries, committed through ${String(commit)}`}>
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
          Each entry shows its index, its term and its command, coloured by term; dashed is not yet committed on that server.
        </p>
      </div>
    </div>
  );
}
