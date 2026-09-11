import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  buildPlan,
  createJoinDemoDatabase,
  createSeedDatabase,
  DEFAULT_ENGINE_OPTIONS,
  estimatePlan,
  OPTIMIZER_RULES,
  optimize,
  parse,
  runQuery,
  toPlanDisplay,
} from '../../engine/index.ts';
import type { Database, Plan, Table } from '../../engine/index.ts';
import { PlanTree } from '../../ui/panels/PlanTree.tsx';
import { PageHeader } from '../../ui/PageHeader.tsx';
import { inputField, panelSurface } from '../../ui/primitives.ts';

/**
 * The optimizer standalone (plan.md §22.3). The rewrite rules already exist
 * (`src/engine/planner/optimize.ts`); what is new here is running them one at a
 * time. Type a query, toggle each rule and the `id` index on or off, and watch
 * the canonical plan and the optimised plan side by side — the seam between
 * `/stages/plan` (fixed query, no toggles) and `/compare` (metrics, not trees).
 *
 * It takes SQL, like `/tools/parser`: the "non-SQL driver" the rest of §22.3
 * wants is infrastructure that does not exist, and a text box sidesteps it.
 * Validation is `runQuery`'s own — an unknown column or table fails the same
 * way it does in the Playground.
 *
 * Each node carries the cost model's `~N rows` estimate and the heuristic
 * behind it (plan.md §22.2) — which is the "table stats" this tool's §22.3
 * entry left for later.
 *
 * URL state: `q` (the query), `idx` (`1`/`0`, the index), `rules` (a
 * comma-separated subset of the rule names). All parsed defensively.
 */

const DEFAULT_SQL = 'SELECT name, email\nFROM users\nWHERE id = 5 AND age > 30';
const MAX_SQL = 2000;

const SEED = createSeedDatabase();
const USERS = SEED.tables.users!;
const { indexedColumn: _dropped, ...USERS_NO_INDEX } = USERS;

// `authors`/`posts` sit alongside `users` (plan.md §22.2) purely so a typed
// query can JOIN them — small on purpose, so a full unfiltered join stays
// legible. They never move with the `id`-index toggle above; only `users`
// does.
const JOIN_DEMO = createJoinDemoDatabase();
const AUTHORS = JOIN_DEMO.tables.authors!;
const POSTS = JOIN_DEMO.tables.posts!;

function readInitial() {
  const p = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const q = p.get('q');
  const rulesRaw = p.get('rules');
  return {
    sql: q !== null && q.length > 0 && q.length <= MAX_SQL ? q : DEFAULT_SQL,
    indexed: p.get('idx') !== '0',
    rules:
      rulesRaw === null
        ? new Set<string>(OPTIMIZER_RULES)
        : new Set(rulesRaw.split(',').filter((r) => OPTIMIZER_RULES.includes(r))),
  };
}

const INITIAL = readInitial();

export function PlannerToolPage() {
  const [sql, setSql] = useState(INITIAL.sql);
  const [indexed, setIndexed] = useState(INITIAL.indexed);
  const [rules, setRules] = useState<Set<string>>(INITIAL.rules);

  const table: Table = indexed ? USERS : USERS_NO_INDEX;
  // `authors`/`posts` sit alongside `users` so a typed query can JOIN them;
  // only `users` moves with the index toggle above.
  const db: Database = useMemo(
    () => ({ tables: { users: table, authors: AUTHORS, posts: POSTS } }),
    [table],
  );

  // `runQuery` is the app's own validator — parse errors, unknown table, unknown
  // column all surface here exactly as they do in the Playground.
  const validation = useMemo(() => runQuery(sql, db, DEFAULT_ENGINE_OPTIONS), [sql, db]);

  const plans = useMemo(() => {
    if (validation.error) return null;
    const parsed = parse(sql);
    if (!parsed.ok) return null;
    // The rules and the cost model both key off the table the query is
    // actually against — `users` by default, but `authors`/`posts` once a
    // typed query names one of those instead (plan.md §22.2's JOIN).
    const fromTable = db.tables[parsed.ast.from.name] ?? table;
    const canonical = buildPlan(parsed.ast);
    const steps = optimize(canonical, fromTable, rules);
    const last = steps.at(-1);
    const optimised = last ? last.plan : canonical;
    const lastChanged: ReadonlySet<Plan> = last ? last.changed : new Set<Plan>();
    const rpp = DEFAULT_ENGINE_OPTIONS.rowsPerPage;
    return {
      canonical: toPlanDisplay(canonical, new Set<Plan>(), estimatePlan(canonical, fromTable, rpp, db.tables)),
      optimised: toPlanDisplay(optimised, lastChanged, estimatePlan(optimised, fromTable, rpp, db.tables)),
      firedRules: new Set(steps.map((s) => s.rule)),
      steps,
    };
  }, [validation.error, sql, db, table, rules]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      const p = new URLSearchParams();
      p.set('q', sql);
      p.set('idx', indexed ? '1' : '0');
      p.set('rules', [...rules].join(','));
      const next = `${location.pathname}?${p.toString()}`;
      if (next !== `${location.pathname}${location.search}`) history.replaceState(null, '', next);
    }, 250);
    return () => { window.clearTimeout(t); };
  }, [sql, indexed, rules]);

  function toggleRule(name: string) {
    setRules((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Planner sandbox">
        A query&rsquo;s plan is a tree of operators; the optimizer rewrites it with a handful of
        rules. Type a query, turn each rule and the <code className="font-mono text-ink">id</code>{' '}
        index on or off, and watch the plan change. This is the plan and optimize stages from the{' '}
        <Link to="/playground" className="underline underline-offset-2 hover:text-ink">
          Playground
        </Link>
        , with the rules on switches. Each node also shows the cost model&rsquo;s{' '}
        <code className="font-mono text-ink">~N rows</code> estimate and the heuristic it used. Two
        more tables, <code className="font-mono text-ink">authors</code> and{' '}
        <code className="font-mono text-ink">posts</code>, sit alongside <code className="font-mono text-ink">users</code> just
        for trying a <code className="font-mono text-ink">JOIN</code> — e.g.{' '}
        <code className="font-mono text-ink">SELECT * FROM authors JOIN posts ON authors.id = posts.authorId</code>.
      </PageHeader>

      <label htmlFor="q" className="mt-4 flex flex-col gap-1 text-label text-ink-dim">
        SQL query
        <textarea
          id="q"
          value={sql}
          onChange={(e) => { setSql(e.target.value.slice(0, MAX_SQL)); }}
          rows={3}
          spellCheck={false}
          className={`${inputField} resize-y font-mono`}
        />
      </label>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-edge bg-surface-2 p-3 text-label shadow-e1">
        <label className="flex items-center gap-2 text-ink-dim">
          <input
            type="checkbox"
            checked={indexed}
            onChange={(e) => { setIndexed(e.target.checked); }}
            className="accent-[var(--color-accent)]"
          />
          <code className="font-mono text-ink">id</code> index
        </label>
        <span className="text-ink-dim/60">rules:</span>
        {OPTIMIZER_RULES.map((name) => (
          <label key={name} className="flex items-center gap-2 text-ink-dim">
            <input
              type="checkbox"
              checked={rules.has(name)}
              onChange={() => { toggleRule(name); }}
              className="accent-[var(--color-accent)]"
            />
            <span className="font-mono">{name}</span>
          </label>
        ))}
      </div>

      {validation.error ? (
        <div className="rounded-lg border border-evict/40 bg-evict/10 p-3">
          <p className="text-label text-ink">{validation.error.message}</p>
          {validation.error.hint && (
            <p className="mt-1 text-label text-ink-dim">{validation.error.hint}</p>
          )}
        </div>
      ) : plans ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <figure className={`${panelSurface} flex min-h-64 flex-col p-4`}>
              <figcaption className="mb-2 text-label font-medium text-ink-dim">canonical</figcaption>
              <div className="min-h-0 flex-1">
                <PlanTree root={plans.canonical} empty="—" />
              </div>
            </figure>
            <figure className={`${panelSurface} flex min-h-64 flex-col p-4`}>
              <figcaption className="mb-2 text-label font-medium text-ink-dim">
                optimized
                {plans.firedRules.size === 0 && ' · unchanged'}
              </figcaption>
              <div className="min-h-0 flex-1">
                <PlanTree root={plans.optimised} empty="—" />
              </div>
            </figure>
          </div>

          <ul className="flex flex-col gap-1.5">
            {OPTIMIZER_RULES.map((name) => {
              const off = !rules.has(name);
              const fired = plans.firedRules.has(name);
              const step = plans.steps.find((s) => s.rule === name);
              return (
                <li key={name} className="flex gap-2 text-label leading-relaxed">
                  <span
                    aria-hidden
                    className={`shrink-0 font-mono ${off ? 'text-ink-dim/50' : fired ? 'text-hit' : 'text-ink-dim'}`}
                  >
                    {off ? '✕' : fired ? '✓' : '–'}
                  </span>
                  <span className={off ? 'text-ink-dim/60' : 'text-ink-dim'}>
                    <span className="font-mono text-ink">{name}</span>
                    {' — '}
                    {off
                      ? 'turned off'
                      : fired && step
                        ? step.label
                        : 'no match on this plan'}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <p className="text-label text-ink-dim">Type a query to see its plan.</p>
      )}

      <p className="text-label leading-relaxed text-ink-dim">
        The same rewrites run in the pipeline — step them one event at a time on{' '}
        <Link to="/stages/optimize" className="underline underline-offset-2 hover:text-ink">
          the optimize stage
        </Link>
        , or see what they cost in{' '}
        <Link to="/compare" className="underline underline-offset-2 hover:text-ink">
          Compare
        </Link>
        .
      </p>
    </div>
  );
}
