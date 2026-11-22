import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { demoKeys, HASH_JOIN_LIMITS, planHashJoin } from '../../ui/hashJoin.ts';
import type { HashJoinLeaf, HashJoinPartition } from '../../ui/hashJoin.ts';
import { btnGhost } from '../../ui/primitives.ts';
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
  ToolShell,
} from '../../ui/tool/index.ts';

/**
 * The Grace hash join standalone (plan.md §22.3 `/tools/hash-join`). The
 * engine's real `hashJoin` operator (`exec/operators.ts`, §22.2) never
 * partitions or spills, so this runs its own driver — `src/ui/hashJoin.ts`
 * lays out the whole plan (every partitioning level, each leaf's bucket
 * layout, every match and miss) and this renders it. No playback: like
 * `/tools/sort` it is parameter-driven — change the buffer budget and watch
 * the partition count, the spill, and the I/O move.
 *
 * Laid out on the tool workbench (`src/ui/tool/`): the data and the memory budget in the inspector, every
 * partitioning pass on the stage with the chosen leaf's buckets and probes under it, and the cost sentence as the
 * narration.
 *
 * URL state: `build`/`probe` (key counts), `page` (records per page), `mem`
 * (buffer pages) and `seed` (the probe-key draw). Parsed defensively — a
 * pasted link is a stranger's input, the rule `src/ui/urlState.ts` follows.
 */

const DEFAULTS = { build: 12, probe: 20, pageSize: 2, memPages: 4, seed: 1 };
const MAX_SEED = 999_999;
const PAGE_SIZES = [2, 3, 4] as const;
const MEM_PAGES = [3, 4, 5, 6] as const;

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
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="query"
        header={
          <ToolHeader
            id="hash-join"
            title="Hash join"
            summary="Partition two relations by a hash of the join key, spill what does not fit, then build and probe."
            about={
              <p>
                A hash join matches a build relation and a probe relation by hashing instead of rescanning. Both are
                partitioned by a hash of the join key, and a partition whose build side still exceeds the memory
                budget is partitioned again. Once a partition fits, its build side becomes hash buckets and every
                probe key looks for an equal key. The same buffer pool every{' '}
                <Link to="/tools/buffer-pool" className="underline underline-offset-2 hover:text-ink">
                  disk read
                </Link>{' '}
                in the pipeline shares is what a real engine would spend these I/Os against.
              </p>
            }
          />
        }
        inspector={
          <Inspector summary={`${String(build)} build · ${String(probe)} probe · ${String(memPages)} buffer pages`}>
            <ControlGroup legend="Data">
              <ControlRow label="Build keys" htmlFor="hj-build">
                <Stepper
                  id="hj-build"
                  value={build}
                  min={HASH_JOIN_LIMITS.minBuildKeys}
                  max={HASH_JOIN_LIMITS.maxBuildKeys}
                  unit="build keys"
                  onChange={setBuild}
                />
              </ControlRow>
              <ControlRow label="Probe keys" htmlFor="hj-probe">
                <Stepper
                  id="hj-probe"
                  value={probe}
                  min={HASH_JOIN_LIMITS.minProbeKeys}
                  max={HASH_JOIN_LIMITS.maxProbeKeys}
                  unit="probe keys"
                  onChange={setProbe}
                />
              </ControlRow>
              <ControlRow label="Records per page" labelId="hj-page">
                <Segmented
                  labelledBy="hj-page"
                  tone="stage"
                  value={String(pageSize)}
                  onChange={(v) => { setPageSize(Number(v)); }}
                  options={PAGE_SIZES.map((v) => ({ value: String(v), label: String(v) }))}
                />
              </ControlRow>
              <button
                type="button"
                onClick={() => { setSeed(Math.floor(Math.random() * MAX_SEED)); }}
                className={`${btnGhost} self-start`}
              >
                Shuffle the probe keys
              </button>
            </ControlGroup>
            <ControlGroup legend="Memory">
              <ControlRow label="Buffer pages" labelId="hj-mem" hint="How much of the build side can be resident at once.">
                <Segmented
                  labelledBy="hj-mem"
                  describedBy={hintIdFor('hj-mem')}
                  tone="stage"
                  value={String(memPages)}
                  onChange={(v) => { setMemPages(Number(v)); }}
                  options={MEM_PAGES.map((v) => ({ value: String(v), label: String(v) }))}
                />
              </ControlRow>
            </ControlGroup>
          </Inspector>
        }
        metrics={
          <MetricStrip
            items={[
              { label: 'Partitions per split', value: plan.numPartitions, sub: `${String(plan.memPages)} buffer pages` },
              {
                label: 'Leaf partitions',
                value: plan.leaves.length,
                sub: plan.fitsInMemory ? 'fits in memory, no split needed' : `spills to depth ${String(plan.maxDepth)}`,
              },
              { label: 'Matches', value: plan.matches.length, sub: `of ${String(plan.probeKeys.length)} probe keys`, tone: 'hit' },
              { label: 'Page I/Os', value: plan.totalIO, sub: `${String(plan.partitionIO)} partitioning, ${String(plan.buildProbeIO)} probing` },
            ]}
          />
        }
        stage={
          <StagePanel
            title="Partitions"
            legend="Click a leaf partition (solid border) for its buckets and probes. Dashed ones split again."
          >
            <div className="flex flex-col divide-y divide-edge/60">
              {levels.map(([level, nodes]) => (
                <LevelBlock key={level} level={level} nodes={nodes} selected={selectedLeaf?.id ?? null} onSelect={setSelected} />
              ))}
            </div>
            {selectedLeaf?.leaf && <LeafDetail partition={selectedLeaf} leaf={selectedLeaf.leaf} />}
          </StagePanel>
        }
        narration={
          plan.fitsInMemory
            ? `All ${String(plan.buildKeys.length)} build keys fit in ${String(plan.memPages)} buffer pages, so the join goes straight to build and probe, with no partitioning pass. Add build keys or drop a buffer page to force a real Grace hash join.`
            : `With ${String(plan.memPages)} buffer pages you partition into ${String(plan.numPartitions)} pieces at a time. Partitioning the whole input, and re-partitioning anything still too big, costs ${String(plan.partitionIO)} page I/Os; the final build-and-probe pass over every leaf partition costs ${String(plan.buildProbeIO)} more, ${String(plan.totalIO)} in total.`
        }
      />
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
    <div className="py-3 first:pt-0">
      <div className="mb-2 flex items-baseline gap-2 text-label">
        <h4 className="font-medium text-ink">{title}</h4>
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
    <div className="mt-1 flex flex-col gap-4 border-t border-edge/60 pt-4">
      <h4 className="text-body font-semibold text-ink">
        Partition {partition.slot}, pass {partition.level + 1} — build &amp; probe
      </h4>

      <div>
        <h5 className="mb-2 text-label font-medium text-ink-dim">
          Build phase — {plural(leaf.numBuckets, 'bucket')}
        </h5>
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
                {bucket.hasCollision && (
                  <span className="ml-1.5 rounded px-1.5 py-0.2 font-mono text-[0.68rem] uppercase tracking-wider border border-miss/40 bg-miss/15 text-miss">
                    ⚠ collision
                  </span>
                )}
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
        <h5 className="mb-2 text-label font-medium text-ink-dim">
          Probe phase — {plural(leaf.matches.length, 'match')}, {plural(leaf.misses.length, 'miss')}
        </h5>
        <ul className="flex flex-wrap gap-1.5 text-label">
          {leaf.matches.map((m, i) => (
            <li
              key={`match${String(i)}`}
              title={`probe ${String(m.probeValue)} -> bucket ${String(m.bucket)} -> matched build ${String(m.buildValue)}`}
              className="inline-flex items-center gap-1 rounded border border-hit/40 bg-hit/15 px-2 py-0.5 font-mono tabular-nums text-ink text-[0.75rem]"
            >
              <span>{m.probeValue}</span>
              <span aria-hidden="true" className="font-mono text-[0.65rem] uppercase text-hit font-semibold">
                match
              </span>
            </li>
          ))}
          {leaf.misses.map((m, i) => (
            <li
              key={`miss${String(i)}`}
              title={
                m.collided
                  ? `probe ${String(m.probeValue)} -> bucket ${String(m.bucket)} -> checked a colliding bucket, no match`
                  : `probe ${String(m.probeValue)} -> bucket ${String(m.bucket)} -> empty, no match`
              }
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono tabular-nums text-ink text-[0.75rem] ${
                m.collided ? 'border-miss/40 bg-miss/15' : 'border-edge bg-surface-3'
              }`}
            >
              <span>{m.probeValue}</span>
              <span aria-hidden="true" className="font-mono text-[0.65rem] uppercase text-ink-dim font-semibold">
                {m.collided ? 'collision-miss' : 'miss'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
