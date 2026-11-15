import { useMemo, useState } from 'react';
import type { TpcResult } from '../../engine/twoPhaseCommit.ts';
import { DataView } from '../../ui/DataView.tsx';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnSecondary, inputField, panelSurface, segBase, segOff, segOn } from '../../ui/primitives.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  COORDINATOR_POINTS,
  LOST_MESSAGES,
  PARTICIPANT_POINTS,
  readTpcSettings,
  TPC_LINK_LIMITS,
  TPC_SCENARIOS,
  tpcHref,
} from '../../ui/tpcLinks.ts';
import type { CoordinatorCrashPoint, LostMessage, ParticipantCrashPoint, TpcSettings } from '../../ui/tpcLinks.ts';
import { tpcRun } from '../../ui/tpcRun.ts';

/**
 * The two-phase commit standalone (plan.md §27.5 X2): a coordinator and participants, failures you script — a crash at
 * a point in the protocol, a lost message — and the run drawn lane by lane, with each participant's time in doubt
 * shaded. `engine/twoPhaseCommit.ts` is the model.
 */

const INITIAL = readTpcSettings(typeof location === 'undefined' ? '' : location.search);
const POINT_WORDS: Record<CoordinatorCrashPoint, string> = {
  none: 'does not crash',
  'before-prepare': 'before sending PREPARE',
  'after-prepare': 'after sending PREPARE',
  'after-votes': 'with every vote in, before deciding',
  'after-decision': 'after logging COMMIT, before sending it',
  'after-first-commit': 'after sending COMMIT to the first participant',
};
const P_WORDS: Record<ParticipantCrashPoint, string> = { none: 'does not crash', 'before-vote': 'before voting', 'after-vote': 'after voting YES' };
const RECOVERIES = [0, 2, 5, 10, 20, 40];
const recoverWord = (r: number) => (r === 0 ? 'never comes back' : `back after ${String(r)} ticks`);
const name = (node: number) => (node === 0 ? 'C' : `P${String(node)}`);

function Timeline({ r }: { r: TpcResult }) {
  const lanes = r.participants + 1;
  const W = 760;
  const LANE = 34;
  const span = Math.max(8, r.ticks + 1);
  const x = (t: number) => 40 + (t / span) * (W - 50);
  const y = (node: number) => 16 + node * LANE;
  const crashes = r.events.filter((e) => e.kind === 'crash');
  const downTo = (node: number, from: number) => r.events.find((e) => e.kind === 'recover' && e.node === node && e.t >= from)?.t ?? span;
  return (
    <svg viewBox={`0 0 ${String(W)} ${String(lanes * LANE + 18)}`} className="h-auto w-full" role="img" aria-label={`The run, ${String(r.ticks)} ticks: ${String(r.messages.length)} messages between the coordinator and ${String(r.participants)} participants`}>
      <defs>
        <marker id="tpc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto" className="text-ink-dim">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>
      {Array.from({ length: lanes }, (_, node) => (
        <g key={node}>
          <text x={4} y={y(node) + 4} className="fill-current font-mono text-[11px] text-ink-dim">
            {name(node)}
          </text>
          <line x1={x(0)} x2={x(span)} y1={y(node)} y2={y(node)} className="stroke-edge" strokeWidth={1} />
        </g>
      ))}
      {r.inDoubt.map((d, i) =>
        d.to > d.from ? (
          <rect key={`d${String(i)}`} x={x(d.from)} y={y(i + 1) - 7} width={x(d.to) - x(d.from)} height={14} className={d.resolved ? 'fill-miss/25' : 'fill-evict/30'} />
        ) : null,
      )}
      {crashes.map((c, i) => (
        <rect key={`c${String(i)}`} x={x(c.t)} y={y(c.node) - 9} width={Math.max(2, x(downTo(c.node, c.t)) - x(c.t))} height={18} className="fill-evict/20 stroke-evict" strokeWidth={0.8} strokeDasharray="3 2" />
      ))}
      {r.messages.map((m, i) => {
        const end = m.delivered ?? m.sent + 0.5;
        return (
          <g key={i} className={m.delivered === null ? 'text-evict' : 'text-ink-dim'}>
            <line x1={x(m.sent)} y1={y(m.from)} x2={x(end)} y2={y(m.delivered === null ? (m.from + m.to) / 2 : m.to)} stroke="currentColor" strokeWidth={1} markerEnd={m.delivered === null ? undefined : 'url(#tpc-arrow)'} />
            {m.delivered === null && (
              <text x={x(end)} y={y((m.from + m.to) / 2) + 4} textAnchor="middle" className="fill-current text-[11px]">
                ✕
              </text>
            )}
          </g>
        );
      })}
      {r.logs.map((l, i) => (
        <g key={`l${String(i)}`}>
          <circle cx={x(l.t)} cy={y(l.node)} r={3} className="fill-accent" />
          <text x={x(l.t) + 4} y={y(l.node) - 6} className="fill-current font-mono text-[9px] text-accent">
            {l.record}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function TwoPhaseCommitToolPage() {
  const [s, setS] = useState<TpcSettings>(INITIAL);
  const set = (over: Partial<TpcSettings>) => { setS((cur) => ({ ...cur, ...over })); };
  const r = useMemo(() => tpcRun(s), [s]);
  const n = s.votes.length;
  useAddressBarQuery(tpcHref(s).split('?')[1] ?? '');

  const longest = Math.max(0, ...r.inDoubt.map((d) => d.to - d.from));
  const blocked = r.inDoubt.filter((d) => !d.resolved).length;
  const rows = [
    ...r.messages.map((m) => ({
      t: m.sent,
      who: `${name(m.from)} → ${name(m.to)}`,
      what: `${m.kind}${m.delivered === null ? ` — ${m.why === 'lost' ? 'lost' : 'not delivered: the receiver is down'}` : `, arrives at ${String(m.delivered)}`}`,
    })),
    ...r.events.map((e) => ({ t: e.t, who: name(e.node), what: e.kind === 'log' ? `writes ${e.text} to its log` : e.text })),
  ].sort((a, b) => a.t - b.t);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Two-phase commit">
        One transaction, several machines, and every one must commit or none may. A <strong>coordinator</strong> asks each{' '}
        <strong>participant</strong> to prepare; a participant that can commit writes PREPARED to its log and votes yes —
        and from then on it may not change its mind, only wait to be told. With every vote yes the coordinator writes COMMIT
        to its log, which is the moment the transaction commits, and tells everyone. Crash a machine or lose a message
        below, and watch who is left <em>in doubt</em>, holding their locks, for how long.
      </PageHeader>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Scenarios">
        {TPC_SCENARIOS.map((sc) => (
          <button key={sc.id} type="button" onClick={() => { setS(sc.settings); }} className={btnSecondary}>
            {sc.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Participants
          <select
            value={n}
            onChange={(e) => {
              const m = Number(e.target.value);
              set({ votes: s.votes.padEnd(m, 'y').slice(0, m), crashedParticipant: Math.min(s.crashedParticipant, m), lostParticipant: Math.min(s.lostParticipant, m) });
            }}
            className={inputField}
          >
            {Array.from({ length: TPC_LINK_LIMITS.maxParticipants - TPC_LINK_LIMITS.minParticipants + 1 }, (_, i) => i + TPC_LINK_LIMITS.minParticipants).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        {[...s.votes].map((v, i) => (
          <div key={i} className="flex flex-col gap-1 text-label text-ink-dim">
            P{i + 1} votes
            <div className="flex gap-1" role="radiogroup" aria-label={`P${String(i + 1)} votes`}>
              {(['y', 'n'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={v === c}
                  onClick={() => { set({ votes: s.votes.slice(0, i) + c + s.votes.slice(i + 1) }); }}
                  className={`${segBase} ${v === c ? segOn : segOff}`}
                >
                  {c === 'y' ? 'yes' : 'no'}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          The coordinator…
          <select value={s.coordinatorCrash} onChange={(e) => { set({ coordinatorCrash: e.target.value as CoordinatorCrashPoint }); }} className={inputField}>
            {COORDINATOR_POINTS.map((p) => (
              <option key={p} value={p}>
                {p === 'none' ? 'does not crash' : `crashes ${POINT_WORDS[p]}`}
              </option>
            ))}
          </select>
        </label>
        {s.coordinatorCrash !== 'none' && (
          <label className="flex flex-col gap-1 text-label text-ink-dim">
            …and
            <select value={s.coordinatorRecover} onChange={(e) => { set({ coordinatorRecover: Number(e.target.value) }); }} className={inputField}>
              {RECOVERIES.map((x) => (
                <option key={x} value={x}>
                  {recoverWord(x)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          A participant…
          <select value={s.participantCrash} onChange={(e) => { set({ participantCrash: e.target.value as ParticipantCrashPoint }); }} className={inputField}>
            {PARTICIPANT_POINTS.map((p) => (
              <option key={p} value={p}>
                {p === 'none' ? 'does not crash' : `crashes ${P_WORDS[p]}`}
              </option>
            ))}
          </select>
        </label>
        {s.participantCrash !== 'none' && (
          <>
            <label className="flex flex-col gap-1 text-label text-ink-dim">
              Which
              <select value={s.crashedParticipant} onChange={(e) => { set({ crashedParticipant: Number(e.target.value) }); }} className={inputField}>
                {Array.from({ length: n }, (_, i) => i + 1).map((k) => (
                  <option key={k} value={k}>
                    P{k}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-label text-ink-dim">
              …and
              <select value={s.participantRecover} onChange={(e) => { set({ participantRecover: Number(e.target.value) }); }} className={inputField}>
                {RECOVERIES.map((x) => (
                  <option key={x} value={x}>
                    {recoverWord(x)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Lost message
          <select value={s.lost} onChange={(e) => { set({ lost: e.target.value as LostMessage }); }} className={inputField}>
            {LOST_MESSAGES.map((m) => (
              <option key={m} value={m}>
                {m === 'none' ? 'none' : m === 'VOTE' ? 'a vote' : `a ${m}`}
              </option>
            ))}
          </select>
        </label>
        {s.lost !== 'none' && (
          <label className="flex flex-col gap-1 text-label text-ink-dim">
            {s.lost === 'VOTE' ? 'From' : 'To'}
            <select value={s.lostParticipant} onChange={(e) => { set({ lostParticipant: Number(e.target.value) }); }} className={inputField}>
              {Array.from({ length: n }, (_, i) => i + 1).map((k) => (
                <option key={k} value={k}>
                  P{k}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className={`${panelSurface} flex flex-col gap-1 p-4`}>
        <p className="text-body text-ink">
          <span role="status">
            {r.decision === null
              ? 'No decision was ever logged'
              : `The coordinator decided ${r.decision.outcome.toUpperCase()} at tick ${String(r.decision.t)}`}
          </span>
          {' — '}
          {r.final.map((f, i) => `P${String(i + 1)} ${f.state}${f.t === null ? '' : ` at ${String(f.t)}`}`).join(', ')}.
        </p>
        <p className="text-label text-ink-dim">
          {blocked > 0
            ? `${String(blocked)} participant${blocked === 1 ? ' is' : 's are'} still in doubt when the run ends: they voted yes, so they cannot abort on their own, and nobody can tell them the outcome. That is two-phase commit's blocking.`
            : longest > 0
              ? `The longest time in doubt: ${String(longest)} ticks, holding locks and waiting to be told.`
              : 'Nobody was ever in doubt.'}{' '}
          {r.atomic ? 'Every participant that decided, decided the same way.' : 'Not atomic.'}
        </p>
      </div>

      <DataView
        caption="Everything that happened, in order"
        rows={rows}
        keyOf={(row, i) => `${String(i)}-${String(row.t)}`}
        columns={[
          { header: 'Tick', cell: (row) => row.t },
          { header: 'Who', cell: (row) => row.who },
          { header: 'What', cell: (row) => row.what },
        ]}
      >
        <div className={`${panelSurface} p-4`}>
          <ScrollRegion label="The run, lane by lane" className="overflow-x-auto">
            <Timeline r={r} />
          </ScrollRegion>
          <p className="mt-1 text-label text-ink-dim">
            One lane for the coordinator (C) and one for each participant. Arrows are messages; a ✕ is one that never
            arrived. Dots are log writes. Amber is a participant in doubt — voted yes, not yet told — and red one still in
            doubt when the run ends; a dashed box is a machine that is down.
          </p>
        </div>
      </DataView>

      <div className={`${panelSurface} grid gap-3 p-4 sm:grid-cols-3`}>
        {Array.from({ length: n + 1 }, (_, node) => (
          <div key={node}>
            <p className="text-label font-medium text-ink-dim">{node === 0 ? 'Coordinator’s log' : `P${String(node)}’s log`}</p>
            <p className="font-mono text-label text-ink">
              {r.logs
                .filter((l) => l.node === node)
                .map((l) => `${String(l.t)}: ${l.record}`)
                .join(' · ') || '(empty)'}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
