import { useMemo, useState } from 'react';
import type { TpcResult } from '../../engine/twoPhaseCommit.ts';
import { DataTable } from '../../ui/DataView.tsx';
import { inputField } from '../../ui/primitives.ts';
import { ScrollRegion } from '../../ui/ScrollRegion.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  ControlGroup,
  ControlRow,
  Inspector,
  MetricStrip,
  ScenarioPicker,
  Segmented,
  StagePanel,
  Stepper,
  ToolHeader,
  ToolSection,
  ToolShell,
} from '../../ui/tool/index.ts';
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
 *
 * Laid out on the tool workbench (`src/ui/tool/`): the scenario picker, participants, votes and failures in the
 * inspector, the decision and time in doubt in the readout, the run lane by lane on the stage with a table view, and
 * each machine's log below.
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
const BLURBS: Record<string, string> = {
  commit: 'The happy path: three yes votes, COMMIT logged, everyone told.',
  'one-no': 'A single no vote, and the coordinator must abort everyone.',
  'crash-before-decision': 'Every vote is in, then the coordinator goes down without deciding.',
  'crash-after-decision': 'COMMIT is logged, then a crash before anyone hears it.',
  'never-returns': 'The coordinator decides, crashes, and never recovers: blocking.',
  'half-told': 'One participant hears COMMIT before the crash; the rest wait.',
  'participant-crash': 'A participant votes yes, then goes down mid-protocol.',
  'lost-vote': 'One vote never reaches the coordinator.',
  'lost-commit': 'The coordinator decides, but one COMMIT goes missing.',
};
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
  const [view, setView] = useState<'diagram' | 'table'>('diagram');
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

  const scenarioId = TPC_SCENARIOS.find((sc) => tpcHref(sc.settings) === tpcHref(s))?.id ?? null;
  const lostCount = r.messages.filter((m) => m.delivered === null).length;
  const range = (k: number) => Array.from({ length: k }, (_, i) => i + 1);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="distributed"
        header={
          <ToolHeader
            id="2pc"
            title="Two-phase commit"
            summary="A coordinator asks every participant to prepare, then commits or aborts. Crash a machine or lose a message and see who is left in doubt."
            about={
              <p>
                One transaction, several machines, and every one must commit or none may. A <strong>coordinator</strong>{' '}
                asks each <strong>participant</strong> to prepare; a participant that can commit writes PREPARED to its log
                and votes yes, and from then on it may not change its mind, only wait to be told. With every vote yes the
                coordinator writes COMMIT to its log, which is the moment the transaction commits, and tells everyone.
                Crash a machine or lose a message, and watch who is left <em>in doubt</em>, holding their locks, for how
                long.
              </p>
            }
          />
        }
        inspector={
          <Inspector summary={`${plural(n, 'participant')} · ${scenarioId ? TPC_SCENARIOS.find((sc) => sc.id === scenarioId)!.label : 'custom run'}`}>
              <ScenarioPicker
                id="tpc-scenario"
                scenarios={TPC_SCENARIOS.map((sc) => ({ id: sc.id, title: sc.label, blurb: BLURBS[sc.id] ?? '' }))}
                value={scenarioId}
                onPick={(id) => {
                  const sc = TPC_SCENARIOS.find((x) => x.id === id);
                  if (sc) setS(sc.settings);
                }}
              />
            <ControlGroup legend="Participants">
              <ControlRow label="Participants" htmlFor="tpc-n">
                <Stepper
                  id="tpc-n"
                  value={n}
                  min={TPC_LINK_LIMITS.minParticipants}
                  max={TPC_LINK_LIMITS.maxParticipants}
                  unit="participants"
                  onChange={(m) => {
                    set({ votes: s.votes.padEnd(m, 'y').slice(0, m), crashedParticipant: Math.min(s.crashedParticipant, m), lostParticipant: Math.min(s.lostParticipant, m) });
                  }}
                />
              </ControlRow>
              {[...s.votes].map((v, i) => (
                <ControlRow key={i} label={`P${String(i + 1)} votes`} labelId={`tpc-vote-${String(i)}`}>
                  <Segmented
                    labelledBy={`tpc-vote-${String(i)}`}
                    size="sm"
                    tone="stage"
                    value={v}
                    onChange={(c) => { set({ votes: s.votes.slice(0, i) + c + s.votes.slice(i + 1) }); }}
                    options={[{ value: 'y', label: 'yes' }, { value: 'n', label: 'no' }]}
                  />
                </ControlRow>
              ))}
            </ControlGroup>
            <ControlGroup legend="Failures">
              <ControlRow label="The coordinator" htmlFor="tpc-c" stacked>
                <select id="tpc-c" value={s.coordinatorCrash} onChange={(e) => { set({ coordinatorCrash: e.target.value as CoordinatorCrashPoint }); }} className={`${inputField} w-full`}>
                  {COORDINATOR_POINTS.map((pt) => (
                    <option key={pt} value={pt}>
                      {pt === 'none' ? 'does not crash' : `crashes ${POINT_WORDS[pt]}`}
                    </option>
                  ))}
                </select>
              </ControlRow>
              {s.coordinatorCrash !== 'none' && (
                <ControlRow label="…and" htmlFor="tpc-cr" stacked>
                  <select id="tpc-cr" value={s.coordinatorRecover} onChange={(e) => { set({ coordinatorRecover: Number(e.target.value) }); }} className={`${inputField} w-full`}>
                    {RECOVERIES.map((x) => (
                      <option key={x} value={x}>
                        {recoverWord(x)}
                      </option>
                    ))}
                  </select>
                </ControlRow>
              )}
              <ControlRow label="A participant" htmlFor="tpc-p" stacked>
                <select id="tpc-p" value={s.participantCrash} onChange={(e) => { set({ participantCrash: e.target.value as ParticipantCrashPoint }); }} className={`${inputField} w-full`}>
                  {PARTICIPANT_POINTS.map((pt) => (
                    <option key={pt} value={pt}>
                      {pt === 'none' ? 'does not crash' : `crashes ${P_WORDS[pt]}`}
                    </option>
                  ))}
                </select>
              </ControlRow>
              {s.participantCrash !== 'none' && (
                <>
                  <ControlRow label="Which" htmlFor="tpc-pw">
                    <select id="tpc-pw" value={s.crashedParticipant} onChange={(e) => { set({ crashedParticipant: Number(e.target.value) }); }} className={inputField}>
                      {range(n).map((k) => (
                        <option key={k} value={k}>
                          P{k}
                        </option>
                      ))}
                    </select>
                  </ControlRow>
                  <ControlRow label="…and" htmlFor="tpc-pr" stacked>
                    <select id="tpc-pr" value={s.participantRecover} onChange={(e) => { set({ participantRecover: Number(e.target.value) }); }} className={`${inputField} w-full`}>
                      {RECOVERIES.map((x) => (
                        <option key={x} value={x}>
                          {recoverWord(x)}
                        </option>
                      ))}
                    </select>
                  </ControlRow>
                </>
              )}
              <ControlRow label="Lost message" htmlFor="tpc-lost">
                <select id="tpc-lost" value={s.lost} onChange={(e) => { set({ lost: e.target.value as LostMessage }); }} className={inputField}>
                  {LOST_MESSAGES.map((m) => (
                    <option key={m} value={m}>
                      {m === 'none' ? 'none' : m === 'VOTE' ? 'a vote' : `a ${m}`}
                    </option>
                  ))}
                </select>
              </ControlRow>
              {s.lost !== 'none' && (
                <ControlRow label={s.lost === 'VOTE' ? 'From' : 'To'} htmlFor="tpc-lp">
                  <select id="tpc-lp" value={s.lostParticipant} onChange={(e) => { set({ lostParticipant: Number(e.target.value) }); }} className={inputField}>
                    {range(n).map((k) => (
                      <option key={k} value={k}>
                        P{k}
                      </option>
                    ))}
                  </select>
                </ControlRow>
              )}
            </ControlGroup>
          </Inspector>
        }
        metrics={
          <MetricStrip
            items={[
              {
                label: 'Decision',
                value: r.decision === null ? 'none' : r.decision.outcome.toUpperCase(),
                sub: r.decision === null ? 'never logged' : `logged at tick ${String(r.decision.t)}`,
                ...(r.decision === null ? { tone: 'evict' as const } : {}),
              },
              { label: 'Longest in doubt', value: longest, sub: 'ticks holding locks' },
              { label: 'Still in doubt', value: blocked, sub: 'when the run ends', ...(blocked > 0 ? { tone: 'evict' as const } : {}) },
              { label: 'Messages', value: r.messages.length, sub: lostCount > 0 ? `${String(lostCount)} never arrived` : 'all delivered' },
            ]}
          />
        }
        stage={
          <StagePanel
            title="The run, lane by lane"
            legend={`${String(r.ticks)} ticks`}
            views={[{ value: 'diagram', label: 'Diagram' }, { value: 'table', label: 'Table' }]}
            view={view}
            onView={setView}
          >
            {view === 'diagram' ? (
              <>
                <ScrollRegion label="The run, lane by lane" className="overflow-x-auto">
                  <div className="min-w-[36rem]">
                    <Timeline r={r} />
                  </div>
                </ScrollRegion>
                <p className="mt-2 text-label text-ink-dim">
                  One lane for the coordinator (C) and one for each participant. Arrows are messages; a ✕ is one that
                  never arrived. Dots are log writes. Amber is a participant in doubt (voted yes, not yet told) and red one
                  still in doubt when the run ends; a dashed box is a machine that is down.
                </p>
              </>
            ) : (
              <DataTable
                caption="Everything that happened, in order"
                rows={rows}
                keyOf={(row, i) => `${String(i)}-${String(row.t)}`}
                columns={[
                  { header: 'Tick', cell: (row) => row.t },
                  { header: 'Who', cell: (row) => row.who },
                  { header: 'What', cell: (row) => row.what },
                ]}
              />
            )}
          </StagePanel>
        }
        narration={`${
          r.decision === null ? 'No decision was ever logged' : `The coordinator decided ${r.decision.outcome.toUpperCase()} at tick ${String(r.decision.t)}`
        }: ${r.final.map((f, i) => `P${String(i + 1)} ${f.state}${f.t === null ? '' : ` at ${String(f.t)}`}`).join(', ')}. ${
          blocked > 0
            ? `${String(blocked)} participant${blocked === 1 ? ' is' : 's are'} still in doubt when the run ends: they voted yes, so they cannot abort on their own, and nobody can tell them the outcome. That is two-phase commit's blocking.`
            : longest > 0
              ? `The longest time in doubt: ${String(longest)} ticks, holding locks and waiting to be told.`
              : 'Nobody was ever in doubt.'
        } ${r.atomic ? 'Every participant that decided, decided the same way.' : 'Not atomic.'}`}
      >
        <ToolSection title="Each machine's log" description="What each machine wrote to its log, and when: the records recovery reads to finish the protocol.">
          <div className="grid gap-3 sm:grid-cols-3">
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
        </ToolSection>
      </ToolShell>
    </div>
  );
}

const plural = (k: number, w: string) => `${String(k)} ${k === 1 ? w : `${w}s`}`;
