import { useMemo, useState } from 'react';
import { PARTITION_LIMITS, PARTITION_SCHEMES } from '../../engine/partitioning.ts';
import type { Placement, PartitionScheme } from '../../engine/partitioning.ts';
import { DataTable } from '../../ui/DataView.tsx';
import { DistributedJoinSection } from '../../ui/DistributedJoinSection.tsx';
import { readJoinPartitionSettings } from '../../ui/joinPartitionLinks.ts';
import type { JoinPartitionSettings } from '../../ui/joinPartitionLinks.ts';
import {
  PARTITION_KEYS,
  PARTITION_ROWS,
  partitionRun,
  readPartitionSettings,
  SCHEME_LABELS,
} from '../../ui/partitionPresets.ts';
import type { ChangeKind, PartitionKey, PartitionSettings } from '../../ui/partitionPresets.ts';
import { controlLabel, inputField } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  CommandBar,
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
 * The partitioning standalone (plan.md §27.5 X1): the transactions preset's rows spread over nodes by hash, by range or
 * by consistent hashing, and what adding a node or taking one away costs in rows that move. `engine/partitioning.ts`
 * is the model.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): scheme, key and nodes in the inspector, the cluster change in the
 * command bar, rows moved and skew in the readout, rows per node on the stage (with the ring or the ranges), and the
 * inserts and the distributed join below.
 *
 * URL state: `k` (key), `p` (scheme), `n` (nodes), `v` (virtual nodes), `c` (change), `r` (the node that leaves); and for
 * the join section (plan.md §27.5 X4), `jn` (nodes), `jo` and `jp` (how orders and payments are partitioned).
 */

const INITIAL = readPartitionSettings(typeof location === 'undefined' ? '' : location.search);
const INITIAL_JOIN = readJoinPartitionSettings(typeof location === 'undefined' ? '' : location.search);
const fmt = (n: number) => n.toLocaleString('en-US');
const pct = (n: number) => `${((n / Math.max(1, PARTITION_ROWS)) * 100).toFixed(0)}%`;
const HUES = ['bg-hue-sky', 'bg-hue-violet', 'bg-hue-amber', 'bg-hue-emerald', 'bg-hue-orange', 'bg-accent', 'bg-hit', 'bg-miss', 'bg-evict', 'bg-node-internal', 'bg-node-leaf'];
const STROKES = ['stroke-hue-sky', 'stroke-hue-violet', 'stroke-hue-amber', 'stroke-hue-emerald', 'stroke-hue-orange', 'stroke-accent', 'stroke-hit', 'stroke-miss', 'stroke-evict', 'stroke-node-internal', 'stroke-node-leaf'];

function Bars({ placement, label, top }: { placement: Placement; label: string; top: number }) {
  return (
    <div>
      <p className="mb-1 text-label font-medium text-ink-dim">{label}</p>
      <ul className="flex flex-col gap-1">
        {placement.nodes.map((node, i) => (
          <li key={node} className="grid grid-cols-[4rem_1fr_4rem] items-center gap-2 text-label">
            <span className="text-ink-dim">node {node}</span>
            <span className="h-3 rounded-full bg-surface-3" aria-hidden>
              <span className={`block h-3 rounded-full ${HUES[(node - 1) % HUES.length]!}`} style={{ width: `${String((placement.counts[i]! / top) * 100)}%` }} />
            </span>
            <span className="text-right tabular-nums text-ink">{fmt(placement.counts[i]!)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-label text-ink-dim">
        skew <span className="tabular-nums text-ink">{placement.skew.toFixed(2)}</span> — the fullest node against the average
      </p>
    </div>
  );
}

function Ring({ placement }: { placement: Placement }) {
  const R = 70;
  const C = 90;
  return (
    <svg viewBox="0 0 180 180" className="h-auto w-44" role="img" aria-label={`The ring: ${String(placement.ring?.length ?? 0)} points for ${String(placement.nodes.length)} nodes`}>
      <circle cx={C} cy={C} r={R} className="fill-none stroke-edge" strokeWidth={1} />
      {(placement.ring ?? []).map((p, i) => {
        const a = p.at * 2 * Math.PI - Math.PI / 2;
        return (
          <line
            key={i}
            x1={C + (R - 7) * Math.cos(a)}
            y1={C + (R - 7) * Math.sin(a)}
            x2={C + (R + 7) * Math.cos(a)}
            y2={C + (R + 7) * Math.sin(a)}
            className={STROKES[(p.node - 1) % STROKES.length]}
            strokeWidth={2}
          />
        );
      })}
    </svg>
  );
}

export function PartitioningToolPage() {
  const [s, setS] = useState<PartitionSettings>(INITIAL);
  const set = (over: Partial<PartitionSettings>) => { setS((cur) => ({ ...cur, ...over, leaving: Math.min(over.leaving ?? cur.leaving, over.nodes ?? cur.nodes) })); };
  const r = useMemo(() => partitionRun(s), [s]);
  const [join, setJoin] = useState<JoinPartitionSettings>(INITIAL_JOIN);
  const [view, setView] = useState<'diagram' | 'table'>('diagram');

  const shareQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('k', s.key);
    p.set('p', s.scheme);
    p.set('n', String(s.nodes));
    p.set('v', String(s.virtualNodes));
    p.set('c', s.change);
    if (s.change === 'remove') p.set('r', String(s.leaving));
    p.set('jn', String(join.nodes));
    p.set('jo', join.orders);
    p.set('jp', join.payments);
    return p.toString();
  }, [s, join]);
  useAddressBarQuery(shareQuery);

  const top = Math.max(...r.before.counts, ...(r.after?.counts ?? []), 1);
  const rows = r.before.nodes.map((node, i) => ({
    node,
    before: r.before.counts[i]!,
    after: r.after ? (r.after.counts[r.after.nodes.indexOf(node)] ?? 0) : null,
  }));
  if (r.after) for (const node of r.after.nodes) if (!r.before.nodes.includes(node)) rows.push({ node, before: 0, after: r.after.counts[r.after.nodes.indexOf(node)]! });

  const consistent = s.scheme === 'consistent';
  const afterLabel = s.change === 'add' ? `After node ${String(s.nodes + 1)} joins` : `After node ${String(s.leaving)} leaves`;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="distributed"
        header={
          <ToolHeader
            id="partitioning"
            title="Partitioning"
            summary="Spread one table over nodes by hash, by range or on a ring, then add or remove a node and count the rows that move."
            about={
              <p>
                A table too big for one machine is cut into partitions, one per node. <strong>Hash</strong> partitioning
                sends a row to <em>hash(key) mod n</em>; <strong>range</strong> partitioning gives each node a contiguous
                range of keys; <strong>consistent hashing</strong> puts every node on a ring at several points and gives a
                row to the first point after its key&rsquo;s hash. All three can spread rows evenly. What they differ in is
                what happens when a node joins or leaves (how many rows have to move) and where new rows land.
              </p>
            }
          />
        }
        inspector={
          <Inspector summary={`${SCHEME_LABELS[s.scheme]} · ${String(s.nodes)} nodes · by ${s.key}`}>
            <ControlGroup legend="Partitioning">
              <ControlRow label="Scheme" labelId="part-scheme" stacked>
                <Segmented
                  labelledBy="part-scheme"
                  tone="stage"
                  value={s.scheme}
                  onChange={(scheme: PartitionScheme) => { set({ scheme }); }}
                  options={PARTITION_SCHEMES.map((scheme) => ({
                    value: scheme,
                    label: scheme === 'consistent' ? 'Ring' : SCHEME_LABELS[scheme],
                    ...(scheme === 'consistent' ? { ariaLabel: `${SCHEME_LABELS[scheme]} (ring)` } : {}),
                  }))}
                />
              </ControlRow>
              <ControlRow label="Key" labelId="part-key" stacked hint={s.key === 'id' ? 'Every key different.' : 'Only 40 distinct keys.'}>
                <Segmented
                  labelledBy="part-key"
                  describedBy={hintIdFor('part-key')}
                  tone="stage"
                  value={s.key}
                  onChange={(key: PartitionKey) => { set({ key }); }}
                  options={PARTITION_KEYS.map((k) => ({ value: k, label: k }))}
                />
              </ControlRow>
              <ControlRow label="Nodes" htmlFor="part-n">
                <Stepper id="part-n" value={s.nodes} min={PARTITION_LIMITS.minNodes} max={PARTITION_LIMITS.maxNodes} unit="nodes" onChange={(nodes) => { set({ nodes }); }} />
              </ControlRow>
              {consistent ? (
                <ControlRow label="Virtual nodes each" htmlFor="part-v" hint="Points each node takes on the ring.">
                  <Stepper id="part-v" value={s.virtualNodes} min={PARTITION_LIMITS.minVirtual} max={PARTITION_LIMITS.maxVirtual} unit="virtual nodes" describedBy={hintIdFor('part-v')} onChange={(virtualNodes) => { set({ virtualNodes }); }} />
                </ControlRow>
              ) : (
                <p className="text-label text-ink-dim">Virtual nodes belong to the ring; this scheme places each node once.</p>
              )}
            </ControlGroup>
          </Inspector>
        }
        command={
          <CommandBar label="Change the cluster">
            <div className={`flex flex-col gap-1 ${controlLabel}`}>
              <span id="part-change">Then</span>
              <Segmented
                labelledBy="part-change"
                tone="stage"
                value={s.change}
                onChange={(change: ChangeKind) => { set({ change }); }}
                options={[
                  { value: 'none', label: 'Nothing' },
                  { value: 'add', label: `Add node ${String(s.nodes + 1)}` },
                  { value: 'remove', label: 'Remove a node' },
                ]}
              />
            </div>
            {s.change === 'remove' && (
              <label htmlFor="part-leaving" className={`flex flex-col gap-1 ${controlLabel}`}>
                Node to remove
                <select id="part-leaving" value={s.leaving} onChange={(e) => { set({ leaving: Number(e.target.value) }); }} className={inputField}>
                  {Array.from({ length: s.nodes }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </CommandBar>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Rows moved', value: r.after ? fmt(r.moved) : '—', sub: r.after ? `${pct(r.moved)} of the table` : 'no change yet' },
              { label: 'Rows that must move', value: r.after ? fmt(r.minimum) : '—', sub: s.change === 'remove' ? 'those on the leaving node' : 'a fair share for the new node' },
              { label: 'Skew before', value: r.before.skew.toFixed(2), sub: 'fullest node ÷ average' },
              { label: 'Skew after', value: r.after ? r.after.skew.toFixed(2) : '—', sub: r.after ? afterLabel.toLowerCase() : 'no change yet' },
            ]}
          />
        }
        stage={
          <StagePanel
            title="Rows on each node"
            legend={`${SCHEME_LABELS[s.scheme]} on ${String(s.nodes)} nodes`}
            views={[{ value: 'diagram', label: 'Diagram' }, { value: 'table', label: 'Table' }]}
            view={view}
            onView={setView}
          >
            {view === 'diagram' ? (
              <div className="flex flex-col gap-5">
                <div className="grid gap-6 sm:grid-cols-2">
                  <Bars placement={r.before} label="Before" top={top} />
                  {r.after && <Bars placement={r.after} label={afterLabel} top={top} />}
                </div>
                {consistent && (
                  <div className="flex flex-wrap items-center gap-6 border-t border-edge/60 pt-4">
                    <Ring placement={r.before} />
                    {r.after && <Ring placement={r.after} />}
                    <p className="max-w-md text-label text-ink-dim">
                      Each mark is one of a node&rsquo;s {s.virtualNodes} points on the ring, coloured by node. A row
                      belongs to the first mark clockwise from its key&rsquo;s hash, so a node owns the arcs that end at
                      its marks. With few marks the arcs are uneven; with many they even out.
                    </p>
                  </div>
                )}
                {s.scheme === 'range' && r.before.ranges && (
                  <div className="border-t border-edge/60 pt-4">
                    <table className="text-label">
                      <caption className="mb-1 text-left text-ink-dim">
                        Each node&rsquo;s range of {s.key}, {r.after ? 'after the change' : 'before any change'}
                      </caption>
                      <thead>
                        <tr className="text-left text-ink-dim">
                          <th scope="col" className="py-1 pr-4 font-medium">Node</th>
                          <th scope="col" className="py-1 pr-4 font-medium">From</th>
                          <th scope="col" className="py-1 pr-4 font-medium">Up to</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono text-ink">
                        {(r.after?.ranges ?? r.before.ranges).map((range) => (
                          <tr key={range.node} className="border-t border-edge/60">
                            <td className="py-1 pr-4">{range.node}</td>
                            <td className="py-1 pr-4">{range.low === null ? 'the start' : String(range.low)}</td>
                            <td className="py-1 pr-4">{range.high === null ? 'the end' : String(range.high)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <DataTable
                caption="Rows on each node, before and after the change"
                rows={rows}
                keyOf={(x) => String(x.node)}
                columns={[
                  { header: 'Node', cell: (x) => x.node },
                  { header: 'Before', cell: (x) => fmt(x.before) },
                  { header: 'After', cell: (x) => (x.after === null ? '—' : fmt(x.after)) },
                ]}
              />
            )}
          </StagePanel>
        }
        narration={
          r.after
            ? `${fmt(r.moved)} rows move (${pct(r.moved)} of the table): ${
                s.change === 'add'
                  ? `a fair share for the new node is ${fmt(r.minimum)}; fewer leaves it under-loaded, more moves rows between nodes that were already there.`
                  : `the ${fmt(r.minimum)} on the node that leaves have to move; any more is churn among the rest.`
              }`
            : 'Add or remove a node in the bar above to count the rows that have to move.'
        }
      >
        <ToolSection title={`Where the next ${String(r.inserts.rows)} rows go`}>
          <p className="text-label text-ink-dim">
            {s.key === 'id' ? `ids ${fmt(PARTITION_ROWS + 1)} to ${fmt(PARTITION_ROWS + r.inserts.rows)}, the way new rows arrive, in key order` : 'The accounts again, in turn'}
            , on the {s.nodes} nodes before any change:{' '}
            <span className="text-ink tabular-nums">{r.inserts.counts.map((c, i) => `node ${String(i + 1)}: ${fmt(c)}`).join(', ')}</span>.
            {s.scheme === 'range' && s.key === 'id' ? ' Every one lands on the last range: one node takes every insert, a hot spot.' : ''}
          </p>
        </ToolSection>
        {/* plan.md §27.5 X4: a join across the partitions, priced in rows over the network. */}
        <DistributedJoinSection settings={join} onChange={setJoin} />
      </ToolShell>
    </div>
  );
}
