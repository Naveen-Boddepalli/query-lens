import { useMemo, useState } from 'react';
import { PARTITION_LIMITS, PARTITION_SCHEMES } from '../../engine/partitioning.ts';
import type { Placement, PartitionScheme } from '../../engine/partitioning.ts';
import { DataView } from '../../ui/DataView.tsx';
import { DistributedJoinSection } from '../../ui/DistributedJoinSection.tsx';
import { readJoinPartitionSettings } from '../../ui/joinPartitionLinks.ts';
import type { JoinPartitionSettings } from '../../ui/joinPartitionLinks.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import {
  PARTITION_KEYS,
  PARTITION_ROWS,
  partitionRun,
  readPartitionSettings,
  SCHEME_LABELS,
} from '../../ui/partitionPresets.ts';
import type { ChangeKind, PartitionKey, PartitionSettings } from '../../ui/partitionPresets.ts';
import { inputField, panelSurface, segBase, segOff, segOn } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';

/**
 * The partitioning standalone (plan.md §27.5 X1): the transactions preset's rows spread over nodes by hash, by range or
 * by consistent hashing, and what adding a node or taking one away costs in rows that move. `engine/partitioning.ts`
 * is the model.
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

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Partitioning">
        A table too big for one machine is cut into partitions, one per node. <strong>Hash</strong> partitioning sends a
        row to <em>hash(key) mod n</em>; <strong>range</strong> partitioning gives each node a contiguous range of keys;{' '}
        <strong>consistent hashing</strong> puts every node on a ring at several points and gives a row to the first point
        after its key&rsquo;s hash. All three can spread rows evenly. What they differ in is what happens when a node joins
        or leaves — how many rows have to move — and where new rows land.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Scheme
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Scheme">
            {PARTITION_SCHEMES.map((scheme: PartitionScheme) => (
              <button key={scheme} type="button" role="radio" aria-checked={s.scheme === scheme} onClick={() => { set({ scheme }); }} className={`${segBase} ${s.scheme === scheme ? segOn : segOff}`}>
                {SCHEME_LABELS[scheme]}
              </button>
            ))}
          </div>
        </div>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Key
          <select value={s.key} onChange={(e) => { set({ key: e.target.value as PartitionKey }); }} className={inputField}>
            {PARTITION_KEYS.map((k) => (
              <option key={k} value={k}>
                {k === 'id' ? 'id — every key different' : 'account — 40 keys'}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Nodes
          <select value={s.nodes} onChange={(e) => { set({ nodes: Number(e.target.value) }); }} className={inputField}>
            {Array.from({ length: PARTITION_LIMITS.maxNodes - PARTITION_LIMITS.minNodes + 1 }, (_, i) => i + PARTITION_LIMITS.minNodes).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Virtual nodes each
          <input
            type="number"
            min={PARTITION_LIMITS.minVirtual}
            max={PARTITION_LIMITS.maxVirtual}
            value={s.virtualNodes}
            disabled={s.scheme !== 'consistent'}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= PARTITION_LIMITS.minVirtual && v <= PARTITION_LIMITS.maxVirtual) set({ virtualNodes: v });
            }}
            className={`${inputField} w-24 tabular-nums`}
          />
        </label>
        <div className="flex flex-col gap-1 text-label text-ink-dim">
          Then
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Change">
            {(
              [
                ['none', 'Nothing'],
                ['add', `Add node ${String(s.nodes + 1)}`],
                ['remove', 'Remove a node'],
              ] as [ChangeKind, string][]
            ).map(([change, label]) => (
              <button key={change} type="button" role="radio" aria-checked={s.change === change} onClick={() => { set({ change }); }} className={`${segBase} ${s.change === change ? segOn : segOff}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {s.change === 'remove' && (
          <label className="flex flex-col gap-1 text-label text-ink-dim">
            Node to remove
            <select value={s.leaving} onChange={(e) => { set({ leaving: Number(e.target.value) }); }} className={inputField}>
              {Array.from({ length: s.nodes }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {r.after && (
        <div className={`${panelSurface} p-4`}>
          <p className="text-body text-ink">
            <span role="status">
              {fmt(r.moved)} rows move ({pct(r.moved)} of the table)
            </span>
            <span className="text-label text-ink-dim">
              {' '}
              —{' '}
              {s.change === 'add'
                ? `a fair share for the new node is ${fmt(r.minimum)}; fewer leaves it under-loaded, more moves rows between nodes that were already there.`
                : `the ${fmt(r.minimum)} on the node that leaves have to move; any more is churn among the rest.`}
            </span>
          </p>
        </div>
      )}

      <h2 className="text-body font-semibold text-ink">Rows on each node</h2>
      <DataView
        caption="Rows on each node, before and after the change"
        rows={rows}
        keyOf={(x) => String(x.node)}
        columns={[
          { header: 'Node', cell: (x) => x.node },
          { header: 'Before', cell: (x) => fmt(x.before) },
          { header: 'After', cell: (x) => (x.after === null ? '—' : fmt(x.after)) },
        ]}
      >
        <div className={`${panelSurface} grid gap-6 p-4 sm:grid-cols-2`}>
          <Bars placement={r.before} label={`${SCHEME_LABELS[s.scheme]} on ${String(s.nodes)} nodes`} top={top} />
          {r.after ? <Bars placement={r.after} label={s.change === 'add' ? `After node ${String(s.nodes + 1)} joins` : `After node ${String(s.leaving)} leaves`} top={top} /> : <div />}
        </div>
      </DataView>

      {s.scheme === 'consistent' && (
        <div className={`${panelSurface} flex flex-wrap items-center gap-6 p-4`}>
          <Ring placement={r.before} />
          {r.after && <Ring placement={r.after} />}
          <p className="max-w-md text-label text-ink-dim">
            Each mark is one of a node&rsquo;s {s.virtualNodes} points on the ring, coloured by node. A row belongs to the first
            mark clockwise from its key&rsquo;s hash, so a node owns the arcs that end at its marks. With few marks the arcs are
            uneven; with many they even out.
          </p>
        </div>
      )}

      {s.scheme === 'range' && r.before.ranges && (
        <div className={`${panelSurface} p-4`}>
          <table className="text-label">
            <caption className="mb-1 text-left text-ink-dim">Each node&rsquo;s range of {s.key}, before{r.after ? ' and after' : ''}</caption>
            <thead>
              <tr className="text-left text-ink-dim">
                <th scope="col" className="py-1 pr-4 font-medium">Node</th>
                <th scope="col" className="py-1 pr-4 font-medium">From</th>
                <th scope="col" className="py-1 pr-4 font-medium">Up to</th>
              </tr>
            </thead>
            <tbody className="font-mono text-ink">
              {(r.after?.ranges ?? r.before.ranges).map((range) => (
                <tr key={range.node} className="border-t border-edge">
                  <td className="py-1 pr-4">{range.node}</td>
                  <td className="py-1 pr-4">{range.low === null ? 'the start' : String(range.low)}</td>
                  <td className="py-1 pr-4">{range.high === null ? 'the end' : String(range.high)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* plan.md §27.5 X4: a join across the partitions, priced in rows over the network. */}
      <DistributedJoinSection settings={join} onChange={setJoin} />

      <div className={`${panelSurface} p-4`}>
        <h2 className="mb-1 text-body font-semibold text-ink">Where the next {r.inserts.rows} rows go</h2>
        <p className="text-label text-ink-dim">
          {s.key === 'id' ? `ids ${fmt(PARTITION_ROWS + 1)} to ${fmt(PARTITION_ROWS + r.inserts.rows)}, the way new rows arrive, in key order` : 'the accounts again, in turn'}
          , on the {s.nodes} nodes before any change:{' '}
          <span className="tabular-nums text-ink">{r.inserts.counts.map((c, i) => `node ${String(i + 1)}: ${fmt(c)}`).join(', ')}</span>.
          {s.scheme === 'range' && s.key === 'id' ? ' Every one lands on the last range — one node takes every insert, a hot spot.' : ''}
        </p>
      </div>
    </div>
  );
}
