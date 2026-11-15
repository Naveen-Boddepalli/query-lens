import { useMemo } from 'react';
import type { DistributedStrategy } from '../engine/distributedJoin.ts';
import { ORDER_CHOICES, PAYMENT_CHOICES } from './joinPartitionLinks.ts';
import type { JoinPartitionSettings } from './joinPartitionLinks.ts';
import { joinPartitionRun } from './joinPartitionRun.ts';
import { inputField, panelSurface } from './primitives.ts';

/**
 * plan.md §27.5 X4: a join across the partitions — 2,000 orders and 3,000 payments, each spread over the nodes as you
 * choose, joined on `orders.id = payments.orderId`, and what co-location, a broadcast and a shuffle each send over the
 * network. `engine/distributedJoin.ts` is the model.
 */

const fmt = (n: number) => n.toLocaleString('en-US');
const WORDS: Record<DistributedStrategy, string> = {
  'co-located': 'Co-located: join where the rows are',
  broadcast: 'Broadcast orders to every node',
  shuffle: 'Shuffle both by the join key',
};
const SHORT: Record<DistributedStrategy, string> = { 'co-located': 'co-located', broadcast: 'broadcast', shuffle: 'shuffle' };

export function DistributedJoinSection({ settings, onChange }: { settings: JoinPartitionSettings; onChange: (s: JoinPartitionSettings) => void }) {
  const r = useMemo(() => joinPartitionRun(settings), [settings]);
  const possible = r.strategies.filter((s) => s.possible);
  const cheapest = possible.reduce((a, b) => (b.moved < a.moved ? b : a));

  return (
    <section className={`${panelSurface} flex flex-col gap-3 p-4`} aria-labelledby="distributed-join-heading">
      <h2 id="distributed-join-heading" className="text-body font-semibold text-ink">
        Joining across the nodes
      </h2>
      <p className="text-label leading-relaxed text-ink-dim">
        <span className="font-mono text-ink">SELECT … FROM orders JOIN payments ON orders.id = payments.orderId</span>, with
        2,000 orders and 3,000 payments each spread over the nodes. Rows with the same key must meet on one node. If both
        tables were partitioned by the same hash of their join columns, they already have; otherwise one side is copied
        everywhere (a broadcast) or both are sent to the node their key hashes to (a shuffle). The price is rows over the
        network.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Join nodes
          <select value={settings.nodes} onChange={(e) => { onChange({ ...settings, nodes: Number(e.target.value) }); }} className={inputField}>
            {Array.from({ length: 9 }, (_, i) => i + 2).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Orders partitioned by
          <select value={settings.orders} onChange={(e) => { onChange({ ...settings, orders: e.target.value }); }} className={inputField}>
            {ORDER_CHOICES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Payments partitioned by
          <select value={settings.payments} onChange={(e) => { onChange({ ...settings, payments: e.target.value }); }} className={inputField}>
            {PAYMENT_CHOICES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-body text-ink">
        <span role="status">
          {r.colocated
            ? 'Co-located: no rows cross the network'
            : `Cheapest: ${SHORT[cheapest.strategy]}, ${fmt(cheapest.moved)} rows over the network`}
        </span>
        <span className="text-label text-ink-dim">
          {' '}
          — {fmt(r.serialMatches)} payments find their order whichever way it runs.
        </span>
      </p>

      <table className="w-full text-left text-label">
        <caption className="mb-1 text-left text-ink-dim">Each strategy on {r.nodes} nodes</caption>
        <thead>
          <tr className="text-ink-dim">
            <th scope="col" className="py-1 pr-3 font-medium">Strategy</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Rows over the network</th>
            <th scope="col" className="py-1 pr-3 text-right font-medium">Busiest node joins</th>
            <th scope="col" className="py-1 text-right font-medium">Matches</th>
          </tr>
        </thead>
        <tbody className="tabular-nums text-ink">
          {r.strategies.map((s) => (
            <tr key={s.strategy} className={`border-t border-edge ${s === cheapest ? 'text-accent' : ''} ${s.possible ? '' : 'text-ink-dim'}`}>
              <th scope="row" className="py-1 pr-3 text-left font-normal">
                {WORDS[s.strategy]}
              </th>
              <td className="py-1 pr-3 text-right">{s.possible ? fmt(s.moved) : 'not possible'}</td>
              <td className="py-1 pr-3 text-right">{s.possible ? `${fmt(Math.max(...s.perNode))} rows` : '—'}</td>
              <td className="py-1 text-right">{s.possible ? fmt(s.matches) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-label text-ink-dim">
        {r.colocated
          ? 'Both tables are spread by the same function of the same key, so every order and its payments already share a node.'
          : 'The tables are not spread by the same function of their join columns — partitioned by another column, or by ranges cut from each table’s own keys — so their rows have to meet first.'}{' '}
        A broadcast copies the 2,000 orders to every other node; a shuffle sends each row whose key hashes elsewhere.
      </p>
    </section>
  );
}
