import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { demoKeys, HASH_JOIN_LIMITS, planHashJoin } from '../../ui/hashJoin.ts';
import type { HashJoinLeaf, HashJoinPartition } from '../../ui/hashJoin.ts';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { btnSecondary, inputField, panelSurface } from '../../ui/primitives.ts';
import { useAddressBarQuery } from '../../ui/addressBar.ts';

/**
 * The Grace hash join standalone (plan.md §22.3 `/tools/hash-join`). The
 * engine's real `hashJoin` operator (`exec/operators.ts`, §22.2) never
 * partitions or spills, so this runs its own driver — `src/ui/hashJoin.ts`
 * lays out the whole plan (every partitioning level, each leaf's bucket
 * layout, every match and miss) and this renders it. No playback: like
 * `/tools/sort` it is parameter-driven — change the buffer budget and watch
 * the partition count, the spill, and the I/O move.
 *
 * URL state: `build`/`probe` (key counts), `page` (records per page), `mem`
 * (buffer pages) and `seed` (the probe-key draw). Parsed defensively — a
 * pasted link is a stranger's input, the rule `src/ui/urlState.ts` follows.
 */

const DEFAULTS = { build: 12, probe: 20, pageSize: 2, memPages: 4, seed: 1 };
const MAX_SEED = 999_999;

function clampInt(raw: string | null, lo: number, hi: number, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback; // Number(null) is 0, not NaN
  const n = Number(raw);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

function readInitial() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  return {
    build: clampInt(p.get('build'), HASH_JOIN_LIMITS.minBuildKeys, HASH_JOIN_LIMITS.maxBuildKeys, DEFAULTS.build),
    probe: clampInt(p.get('probe'), HASH_JOIN_LIMITS.minProbeKeys, HASH_JOIN_LIMITS.maxProbeKeys, DEFAULTS.probe),
    pageSize: clampInt(p.get('page'), HASH_JOIN_LIMITS.minPageSize, HASH_JOIN_LIMITS.maxPageSize, DEFAULTS.pageSize),
    memPages: clampInt(p.get('mem'), HASH_JOIN_LIMITS.minMemPages, HASH_JOIN_LIMITS.maxMemPages, DEFAULTS.memPages),
    seed: clampInt(p.get('seed'), 0, MAX_SEED, DEFAULTS.seed),
  };
}

const INITIAL = readInitial();
const plural = (k: number, s: string) =>
  `${k} ${k === 1 ? s : /(s|sh|ch|x|z)$/.test(s) ? `${s}es` : `${s}s`}`;

export function HashJoinToolPage() {
  const [build, setBuild] = useState(INITIAL.build);
  const [probe, setProbe] = useState(INITIAL.probe);
  const [pageSize, setPageSize] = useState(INITIAL.pageSize);
  const [memPages, setMemPages] = useState(INITIAL.memPages);
  const [seed, setSeed] = useState(INITIAL.seed);
  const [selected, setSelected] = useState<number | null>(null);

  const plan = useMemo(() => {
    const { buildKeys, probeKeys } = demoKeys(build, probe, seed);
    return planHashJoin(buildKeys, probeKeys, { pageSize, memPages });
  }, [build, probe, pageSize, memPages, seed]);

  const shareQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('build', String(build));
    p.set('probe', String(probe));
    p.set('page', String(pageSize));
    p.set('mem', String(memPages));
    p.set('seed', String(seed));
    return p.toString();
  }, [build, probe, pageSize, memPages, seed]);
  useAddressBarQuery(shareQuery);

  // Falls back to the first leaf whenever nothing is explicitly selected, or
  // the selected id doesn't belong to the current plan — so there's always
  // something to read without an effect just to reset the selection.
  const selectedLeaf = useMemo(() => {
    const chosen = selected !== null ? plan.leaves.find((l) => l.id === selected) : undefined;
    return chosen ?? plan.leaves[0] ?? null;
  }, [plan, selected]);

  // Every partition, leaf or not, grouped by its level — one row per
  // partitioning pass, the same shape `/tools/sort` gives each merge pass.
  const levels = useMemo(() => {
    const byLevel = new Map<number, HashJoinPartition[]>();
    const walk = (node: HashJoinPartition) => {
      byLevel.set(node.level, [...(byLevel.get(node.level) ?? []), node]);
      for (const child of node.children ?? []) walk(child);
    };
    walk(plan.root);
    return [...byLevel.entries()].sort(([a], [b]) => a - b);
  }, [plan]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Hash join">
        Join a build side and a probe side by hashing instead of rescanning: partition both by a hash
        of the join key, and re-partition anything that still doesn&rsquo;t fit in memory. Once a
        partition fits, build an in-memory hash table over it and probe with the other side&rsquo;s
        matching partition. Not wired to the engine&rsquo;s real{' '}
        <code className="font-mono text-ink">hashJoin</code> operator (which never partitions or
        spills, plan.md §22.2) — a self-contained model of the fuller Grace hash join.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-4 rounded-xl border border-edge bg-surface-2 p-3 shadow-e1">
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Build keys
          <input
            type="number"
            min={HASH_JOIN_LIMITS.minBuildKeys}
            max={HASH_JOIN_LIMITS.maxBuildKeys}
            value={build}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= HASH_JOIN_LIMITS.minBuildKeys && v <= HASH_JOIN_LIMITS.maxBuildKeys) {
                setBuild(v);
              }
            }}
            className={`${inputField} w-20 tabular-nums`}
          />
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Probe keys
          <input
            type="number"
            min={HASH_JOIN_LIMITS.minProbeKeys}
            max={HASH_JOIN_LIMITS.maxProbeKeys}
            value={probe}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= HASH_JOIN_LIMITS.minProbeKeys && v <= HASH_JOIN_LIMITS.maxProbeKeys) {
                setProbe(v);
              }
            }}
            className={`${inputField} w-20 tabular-nums`}
          />
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Records / page
          <select
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); }}
            className={inputField}
          >
            {[2, 3, 4].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-label text-ink-dim">
          Buffer pages
          <select
            value={memPages}
            onChange={(e) => { setMemPages(Number(e.target.value)); }}
            className={inputField}
          >
            {[3, 4, 5, 6].map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <button
          type="button"
          onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); }}
          className={btnSecondary}
        >
          Shuffle
        </button>
      </div>

      <div className={`${panelSurface} flex flex-wrap items-start gap-x-8 gap-y-3 p-4`}>
        <Stat
          label="partitions per split"
          value={plan.numPartitions}
          sub={`from ${plan.memPages} buffer pages`}
        />
        <Stat
          label="leaf partitions"
          value={plan.leaves.length}
          sub={plan.fitsInMemory ? 'fits in memory, no split needed' : `spilled to depth ${plan.maxDepth}`}
        />
        <Stat
          label="matches"
          value={plan.matches.length}
          sub={`of ${plan.probeKeys.length} probe keys`}
        />
        <Stat
          label="page I/Os"
          value={plan.totalIO}
          sub={`${plan.partitionIO} partitioning + ${plan.buildProbeIO} build/probe`}
          accent
        />
      </div>

      <p className="text-label leading-relaxed text-ink-dim">
        {plan.fitsInMemory ? (
          <>
            All {plan.buildKeys.length} build keys fit in {plan.memPages} buffer pages, so the join
            goes straight to build-and-probe — no partitioning pass at all. Add build keys or drop a
            buffer page to force a real Grace hash join.
          </>
        ) : (
          <>
            With <span className="text-ink">{plan.memPages}</span> buffer pages you partition into{' '}
            <span className="text-ink">{plan.numPartitions}</span> pieces at a time. Partitioning the
            whole input, and re-partitioning anything still too big, costs{' '}
            <span className="text-ink tabular-nums">{plan.partitionIO}</span> page I/Os; the final
            build-and-probe pass over every leaf partition costs{' '}
            <span className="text-ink tabular-nums">{plan.buildProbeIO}</span> more —{' '}
            <span className="text-ink tabular-nums">{plan.totalIO}</span> in total.
          </>
        )}
      </p>

      <div className="flex flex-col gap-3">
        {levels.map(([level, nodes]) => (
          <LevelBlock
            key={level}
            level={level}
            nodes={nodes}
            selected={selectedLeaf?.id ?? null}
            onSelect={setSelected}
          />
        ))}
      </div>

      {selectedLeaf?.leaf && <LeafDetail partition={selectedLeaf} leaf={selectedLeaf.leaf} />}

      <p className="text-label leading-relaxed text-ink-dim">
        Click a leaf partition (solid border) to see its bucket table and probe results. A dashed box
        needed to split again because its build side still didn&rsquo;t fit on its own — a partition
        spill. The same buffer pool every{' '}
        <Link to="/tools/buffer-pool" className="underline underline-offset-2 hover:text-ink">
          disk read
        </Link>{' '}
        in the pipeline shares is what a real engine would spend these I/Os against.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: number;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className={`text-heading font-semibold tabular-nums ${accent ? 'text-accent' : 'text-ink'}`}>
        {value}
      </span>
      <span className="text-label text-ink-dim">{label}</span>
      <span className="text-label text-ink-dim/70">{sub}</span>
    </div>
  );
}

function LevelBlock({
  level,
  nodes,
  selected,
  onSelect,
}: {
  level: number;
  nodes: HashJoinPartition[];
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const title = level === 0 ? 'Partitioning pass 1' : `Partitioning pass ${level + 1} (spill)`;

  return (
    <div className={`${panelSurface} p-3`}>
      <div className="mb-2 flex items-baseline gap-2 text-label">
        <span className="font-medium text-ink">{title}</span>
        <span className="text-ink-dim">{plural(nodes.length, 'partition')}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {nodes.map((node) => {
          const isLeaf = Boolean(node.leaf);
          const isSelected = node.id === selected;
          return (
            <button
              key={node.id}
              type="button"
              disabled={!isLeaf}
              onClick={() => { if (isLeaf) onSelect(node.id); }}
              aria-pressed={isLeaf ? isSelected : undefined}
              className={`flex max-w-full flex-col gap-1 rounded-lg border p-2 text-left text-label transition ${
                isLeaf
                  ? `border-edge bg-surface-3 hover:border-ink-dim/50 ${isSelected ? 'ring-2 ring-accent' : ''}`
                  : 'border-dashed border-ink-dim/40 bg-surface-3/50'
              }`}
            >
              <span className="text-ink-dim">partition {node.slot}</span>
              <span className="tabular-nums text-ink">
                {plural(node.buildKeys.length, 'build key')}, {plural(node.probeKeys.length, 'probe key')}
              </span>
              <span className="text-ink-dim/70">
                {isLeaf
                  ? node.leaf!.overBudget
                    ? 'still over budget — built anyway'
                    : 'fits — build & probe'
                  : 'too big — splits further'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function LeafDetail({ partition, leaf }: { partition: HashJoinPartition; leaf: HashJoinLeaf }) {
  return (
    <div className={`${panelSurface} flex flex-col gap-4 p-4`}>
      <h3 className="text-body font-semibold text-ink">
        Partition {partition.slot}, pass {partition.level + 1} — build &amp; probe
      </h3>

      <div>
        <h4 className="mb-2 text-label font-medium text-ink-dim">
          Build phase — {plural(leaf.numBuckets, 'bucket')}
        </h4>
        <div className="flex flex-wrap gap-2">
          {leaf.buckets.map((bucket) => (
            <div
              key={bucket.index}
              className={`rounded-lg border p-2 text-label ${
                bucket.hasCollision ? 'border-miss/60 bg-miss/10' : 'border-edge bg-surface-3'
              }`}
            >
              <div className="text-ink-dim">
                bucket {bucket.index}
                {bucket.hasCollision && <span className="ml-1.5 text-miss">⚠ collision</span>}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {bucket.entries.length === 0 ? (
                  <span className="text-ink-dim/70">empty</span>
                ) : (
                  bucket.entries.map((e) => (
                    <span key={e.row} className="rounded bg-surface px-1.5 py-0.5 font-mono tabular-nums text-ink">
                      {e.value}
                    </span>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-label font-medium text-ink-dim">
          Probe phase — {plural(leaf.matches.length, 'match')}, {plural(leaf.misses.length, 'miss')}
        </h4>
        <ul className="flex flex-wrap gap-1.5 text-label">
          {leaf.matches.map((m, i) => (
            <li
              key={`match${String(i)}`}
              title={`probe ${String(m.probeValue)} → bucket ${String(m.bucket)} → matched build ${String(m.buildValue)}`}
              className="rounded bg-hit/20 px-1.5 py-0.5 font-mono tabular-nums text-ink"
            >
              {m.probeValue} ✓
            </li>
          ))}
          {leaf.misses.map((m, i) => (
            <li
              key={`miss${String(i)}`}
              title={
                m.collided
                  ? `probe ${String(m.probeValue)} → bucket ${String(m.bucket)} → checked a colliding bucket, no match`
                  : `probe ${String(m.probeValue)} → bucket ${String(m.bucket)} → empty, no match`
              }
              className={`rounded px-1.5 py-0.5 font-mono tabular-nums text-ink ${
                m.collided ? 'bg-miss/20' : 'bg-surface-3'
              }`}
            >
              {m.probeValue} {m.collided ? '↯' : '✕'}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
