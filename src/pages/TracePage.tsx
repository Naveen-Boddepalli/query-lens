import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DATASETS,
  DEFAULT_ENGINE_OPTIONS,
  REPLACEMENT_POLICY_LABELS,
  REPLACEMENT_POLICY_NAMES,
  runQuery,
} from '../engine/index.ts';
import type { ReplacementPolicyName, Stage, StepEvent } from '../engine/index.ts';
import { otherColumnsOf, presetWithRows, readDatasetParam, readShareState } from '../ui/urlState.ts';
import { DATASET_CATALOGUE } from '../ui/datasetCatalogue.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import {
  btnPrimary,
  btnSecondary,
  inputField,
  panelSurface,
  segBase,
  segOff,
  segOn,
} from '../ui/primitives.ts';
import { ScrollRegion } from '../ui/ScrollRegion.tsx';
import { useAddressBarQuery } from '../ui/addressBar.ts';

const search = typeof location === 'undefined' ? '' : location.search;

// The inspector honours the Playground's `t` (preset dataset, plan.md §22.7)
// so a link copied from one opens usefully in the other.
const DATASET = DATASETS[readDatasetParam(search)];
const TABLE = DATASET.table;
const SEED = DATASET.make();
const COLUMNS = SEED.tables[TABLE]?.columns ?? [];
const DEFAULT_SQL = DATASET_CATALOGUE[DATASET.id].starterSql;

const SHARED = readShareState(search, COLUMNS, otherColumnsOf(SEED, TABLE));
/**
 * The link's data, passed on untouched to every link this page writes: the preset (`t`), the main table's rows (`d`)
 * and a multi-table preset's other tables' (`d.<table>`, plan.md §27.5 S2). Dropping `t` here once sent a copied
 * `/trace` link back to `users` with another preset's query.
 */
const CARRIED_PARAMS = [...new URLSearchParams(search)].filter(([key]) => key === 't' || key === 'd' || key.startsWith('d.'));

// `readShareState` allow-lists `p` to `lru`/`clock` (the Playground's contract).
// The inspector is a dev tool and runs any of the five, so it parses `p`
// itself — still against a fixed list, still total on a bad value.
const RAW_POLICY = new URLSearchParams(search).get('p');
const START_POLICY: ReplacementPolicyName = (REPLACEMENT_POLICY_NAMES as readonly string[]).includes(
  RAW_POLICY ?? '',
)
  ? (RAW_POLICY as ReplacementPolicyName)
  : DEFAULT_ENGINE_OPTIONS.policy;

type View = 'table' | 'transcript';
const START_VIEW: View = new URLSearchParams(search).get('v') === 'transcript' ? 'transcript' : 'table';

const START = {
  sql: SHARED.sql ?? DEFAULT_SQL,
  policy: START_POLICY,
  db: presetWithRows(SEED, TABLE, SHARED.rows, SHARED.otherRows),
};

/** A stage name with its colour carried by a small square rather than the
 *  text — `--color-stage-*` was tuned as a panel accent and some of the eight
 *  fall just under 4.5:1 as 13px body text on a light surface (the axe gate). */
function StageTag({ stage, dim = false }: { stage: Stage; dim?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono">
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-sm"
        style={{ background: `var(--color-stage-${stage})` }}
      />
      <span className={dim ? 'text-ink-dim line-through' : 'text-ink'}>{stage}</span>
    </span>
  );
}

/** The stage-specific fields of an event, as one compact line. */
function detailOf(e: StepEvent): string {
  switch (e.stage) {
    case 'parse':
      return e.span ? `span ${e.span.from}–${e.span.to}` : 'ast';
    case 'plan':
      return 'planTree';
    case 'optimize':
      return `rule ${e.rule}`;
    case 'execute':
      return `${e.op} · ${e.rowsProduced} row${e.rowsProduced === 1 ? '' : 's'}`;
    case 'buffer':
      switch (e.action) {
        case 'miss':
          return `miss · page ${e.pageId}`;
        case 'evict':
          return `evict · frame ${e.frameId} drops page ${e.victimPageId} for ${e.pageId}${e.clockHand === undefined ? '' : ` · hand ${e.clockHand}`}`;
        case 'sweep':
          return `sweep · frame ${e.frameId} → usage ${e.usageCountAfter} · hand ${e.clockHand}`;
        default:
          return `${e.action} · page ${e.pageId} → frame ${e.frameId}`;
      }
    case 'index':
      switch (e.action) {
        case 'open':
          return `open · ${e.nodeId} · height ${e.height}`;
        case 'traverse':
          return `traverse · ${e.nodeId}${e.childIndex === undefined ? '' : ` → child ${e.childIndex}`}`;
        case 'chain-next':
          return `chain-next · ${e.fromNodeId} → ${e.toNodeId}`;
        default:
          return `${e.action} · ${e.nodeId}`;
      }
    case 'lock':
      return `${e.action} · ${e.mode} · page ${e.pageId}`;
    case 'result':
      return `${e.rows.length} row${e.rows.length === 1 ? '' : 's'}`;
  }
}

export function TracePage() {
  const [sql, setSql] = useState(START.sql);
  const [policy, setPolicy] = useState<ReplacementPolicyName>(START.policy);
  const [ran, setRan] = useState({ sql: START.sql, policy: START.policy });
  const [stageOff, setStageOff] = useState<ReadonlySet<Stage>>(new Set());
  const [query, setQuery] = useState('');
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<View>(START_VIEW);

  const result = useMemo(
    () => runQuery(ran.sql, START.db, { ...DEFAULT_ENGINE_OPTIONS, policy: ran.policy }),
    [ran],
  );

  const stagesPresent = useMemo(() => {
    const seen = new Set<Stage>();
    for (const e of result.events) seen.add(e.stage);
    return [...seen];
  }, [result]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return result.events.filter(
      (e) =>
        !stageOff.has(e.stage) &&
        (needle === '' || e.label.toLowerCase().includes(needle) || detailOf(e).toLowerCase().includes(needle)),
    );
  }, [result, stageOff, query]);

  const shareQuery = useMemo(() => {
    const params = new URLSearchParams();
    params.set('q', sql);
    params.set('p', policy);
    for (const [key, value] of CARRIED_PARAMS) params.set(key, value);
    if (view === 'transcript') params.set('v', 'transcript');
    return params.toString();
  }, [sql, policy, view]);
  useAddressBarQuery(shareQuery);

  function toggleStage(stage: Stage) {
    setStageOff((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(shown, null, 2));
      setCopied(true);
      window.setTimeout(() => { setCopied(false); }, 2000);
    } catch {
      setCopied(false);
    }
  }

  const playgroundLink = (step?: number) => {
    const params = new URLSearchParams();
    params.set('q', ran.sql);
    params.set('p', ran.policy);
    if (step !== undefined) params.set('s', String(step));
    for (const [key, value] of CARRIED_PARAMS) params.set(key, value);
    return `/playground?${params.toString()}`;
  };

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Trace inspector">
        The raw event stream <code className="font-mono text-ink">runQuery</code> produces for a
        query — the array every panel folds. Filter it, inspect collapsible JSON nodes, copy as JSON,
        or jump directly to any step in the{' '}
        <Link to={playgroundLink()} className="underline underline-offset-2 hover:text-ink">
          Playground
        </Link>
        .
      </PageHeader>

      <div className="mt-4 flex flex-col gap-3 rounded-xl border border-edge bg-surface-2 p-4 shadow-neu-rest backdrop-blur-sm">
        <label htmlFor="sql" className="flex flex-col gap-1 text-label text-ink-dim">
          Query
          <textarea
            id="sql"
            value={sql}
            onChange={(e) => { setSql(e.target.value); }}
            rows={3}
            spellCheck={false}
            className={`${inputField} resize-y font-mono`}
          />
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor="policy" className="flex flex-col gap-1 text-label text-ink-dim">
            Eviction policy
            <select
              id="policy"
              value={policy}
              onChange={(e) => { setPolicy(e.target.value as ReplacementPolicyName); }}
              className={inputField}
            >
              {REPLACEMENT_POLICY_NAMES.map((name) => (
                <option key={name} value={name}>{REPLACEMENT_POLICY_LABELS[name]}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => { setRan({ sql, policy }); setOpenRow(null); }}
            className={btnPrimary}
          >
            Run
          </button>
        </div>
      </div>

      {result.error ? (
        <div className="rounded-lg border border-evict/40 bg-evict/10 p-4">
          <p className="text-body font-medium text-ink">{result.error.message}</p>
          {result.error.hint && <p className="mt-1 text-label text-ink-dim">{result.error.hint}</p>}
          <p className="mt-2 text-label text-ink-dim">
            {result.events.length} event{result.events.length === 1 ? '' : 's'} emitted before it stopped.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="View">
            {(
              [
                ['table', 'Table'],
                ['transcript', 'Transcript'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={view === value}
                onClick={() => { setView(value); }}
                className={`${segBase} ${view === value ? segOn : segOff}`}
              >
                {label}
              </button>
            ))}
          </div>

          {view === 'table' ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {stagesPresent.map((stage) => {
                  const off = stageOff.has(stage);
                  return (
                    <button
                      key={stage}
                      type="button"
                      aria-pressed={!off}
                      onClick={() => { toggleStage(stage); }}
                      className={`rounded-full border px-2.5 py-0.5 text-label transition ${
                        off ? 'border-dashed border-edge' : 'border-edge bg-surface-3'
                      }`}
                    >
                      <StageTag stage={stage} dim={off} />
                    </button>
                  );
                })}
                <input
                  type="text"
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); }}
                  placeholder="filter events…"
                  className={`${inputField} ml-auto w-48`}
                  aria-label="Filter events by text"
                />
                <button type="button" onClick={() => { void copyJson(); }} className={btnSecondary}>
                  {copied ? 'Copied' : 'Copy JSON'}
                </button>
              </div>

              <p className="text-label text-ink-dim tabular-nums">
                {shown.length} of {result.events.length} events
                {result.rows.length > 0 && ` · query returned ${result.rows.length} row${result.rows.length === 1 ? '' : 's'}`}
              </p>

              <ScrollRegion label="Trace events" className={`${panelSurface} min-h-0 flex-1 overflow-auto p-0`}>
                <table className="w-full border-collapse text-label">
                  <thead className="sticky top-0 z-10 bg-surface-2 text-ink-dim">
                    <tr className="border-b border-edge text-left">
                      <th className="px-3 py-2 font-medium tabular-nums">#</th>
                      <th className="px-3 py-2 font-medium">stage</th>
                      <th className="px-3 py-2 font-medium">detail</th>
                      <th className="px-3 py-2 font-medium">narration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-6 text-center text-ink-dim">
                          No events match the current filter.
                        </td>
                      </tr>
                    )}
                    {shown.map((e) => (
                      <FragmentRow
                        key={e.id}
                        event={e}
                        open={openRow === e.id}
                        onToggle={() => { setOpenRow((cur) => (cur === e.id ? null : e.id)); }}
                        href={playgroundLink(e.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-label text-ink-dim tabular-nums">
                  {result.events.length} step{result.events.length === 1 ? '' : 's'}
                  {result.rows.length > 0 && ` · ${result.rows.length} row${result.rows.length === 1 ? '' : 's'} returned`}
                </p>
                <button
                  type="button"
                  onClick={() => { window.print(); }}
                  className={btnSecondary}
                >
                  Print
                </button>
              </div>

              <div data-print className={`${panelSurface} min-h-0 flex-1 overflow-auto p-4`}>
                <h2 className="mb-1 font-mono text-label text-ink">
                  {ran.sql.replace(/\s+/g, ' ').trim()}
                </h2>
                <p className="mb-4 text-label text-ink-dim">
                  {REPLACEMENT_POLICY_LABELS[ran.policy]} · {result.events.length} steps · every line
                  opens the Playground at that step
                </p>
                <ol className="space-y-2">
                  {result.events.map((e) => (
                    <li key={e.id} className="flex gap-3 text-body leading-relaxed">
                      <Link
                        to={playgroundLink(e.id)}
                        className="shrink-0 font-mono text-label text-ink-dim tabular-nums underline-offset-2 hover:text-accent hover:underline"
                        title="Open the Playground at this step"
                      >
                        {String(e.id).padStart(3, '0')}
                      </Link>
                      <span className="shrink-0">
                        <StageTag stage={e.stage} />
                      </span>
                      <span className="min-w-0">{e.label}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function FragmentRow({
  event,
  open,
  onToggle,
  href,
}: {
  event: StepEvent;
  open: boolean;
  onToggle: () => void;
  href: string;
}) {
  return (
    <>
      <tr
        className="cursor-pointer border-b border-edge/60 align-top scroll-mt-10 transition-colors hover:bg-surface-3/60"
        onClick={onToggle}
      >
        <td className="px-3 py-2 font-mono tabular-nums text-ink-dim">
          <Link
            to={href}
            onClick={(ev) => { ev.stopPropagation(); }}
            className="underline-offset-2 hover:text-accent hover:underline"
            title="Open the Playground at this step"
          >
            {event.id}
          </Link>
        </td>
        <td className="px-3 py-2">
          <StageTag stage={event.stage} />
        </td>
        <td className="px-3 py-2 font-mono text-ink-dim">
          {detailOf(event)}
          {event.dwell !== undefined && event.dwell !== 1 && (
            <span className="ml-1.5 text-ink-dim/70">· dwell {event.dwell}</span>
          )}
          {event.predictable && (
            <span className="ml-1.5 rounded border border-accent/40 bg-accent-soft/30 px-1 text-accent">predict</span>
          )}
        </td>
        <td className="px-3 py-2 text-ink">{event.label}</td>
      </tr>
      {open && (
        <tr className="border-b border-edge bg-surface-3/40">
          <td colSpan={4} className="px-3 py-2">
            <pre className="font-mono text-label break-words whitespace-pre-wrap text-ink-dim">
              {JSON.stringify(event, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
