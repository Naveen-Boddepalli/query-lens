import { useMemo, useState } from 'react';
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
import { WhyNotNote } from '../../ui/WhyNotNote.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';

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
const { indexedColumns: _dropped, ...USERS_NO_INDEX } = USERS;

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
    const rpp = DEFAULT_ENGINE_OPTIONS.rowsPerPage;
    const steps = optimize(canonical, fromTable, rpp, db.tables, rules);
    const last = steps.at(-1);
    const optimised = last ? last.plan : canonical;
    const lastChanged: ReadonlySet<Plan> = last ? last.changed : new Set<Plan>();
    return {
      canonical: toPlanDisplay(canonical, new Set<Plan>(), estimatePlan(canonical, fromTable, rpp, db.tables)),
      optimised: toPlanDisplay(optimised, lastChanged, estimatePlan(optimised, fromTable, rpp, db.tables)),
      firedRules: new Set(steps.map((s) => s.rule)),
      steps,
    };
  }, [validation.error, sql, db, table, rules]);

  const shareQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('q', sql);
    p.set('idx', indexed ? '1' : '0');
    p.set('rules', [...rules].join(','));
    return p.toString();
  }, [sql, indexed, rules]);
  useAddressBarQuery(shareQuery);

  function toggleRule(name: string) {
    setRules((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 p-6 sm:p-8">
      <PageHeader
        breadcrumbs={[{ label: 'Tools', to: '/tools' }, { label: 'Planner & Optimizer' }]}
        title="Planner & Optimizer Sandbox"
      >
        A query&rsquo;s plan is a tree of operators; the optimizer rewrites it with heuristic
        rules. Type a query, toggle each rule and the <code className="font-mono text-ink">id</code>{' '}
        index on or off, and observe operator plan transformations side-by-side. Tables{' '}
        <code className="font-mono text-ink">authors</code> and <code className="font-mono text-ink">posts</code> are
        also available for testing <code className="font-mono text-ink">JOIN</code> queries.
      </PageHeader>

      {/* SQL Input Area */}
      <div className="ql-sheen flex flex-col gap-2 rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-md">
        <label htmlFor="q" className="flex items-center justify-between text-label text-ink-dim">
          <span className="font-mono uppercase tracking-wider text-[0.75rem]">SQL Query Source</span>
          <span className="text-[0.75rem] font-mono text-ink-dim/70">users &middot; authors &middot; posts</span>
        </label>
        <textarea
          id="q"
          value={sql}
          onChange={(e) => { setSql(e.target.value.slice(0, MAX_SQL)); }}
          rows={3}
          spellCheck={false}
          className={`${inputField} resize-y font-mono text-[0.85rem]`}
        />
      </div>

      {/* Controls & Rule Toggles */}
      <div className="ql-sheen flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-xl border border-edge bg-surface-2/80 p-4 text-label shadow-neu-rest backdrop-blur-md">
        <label className="flex items-center gap-2 text-ink-dim cursor-pointer select-none">
          <input
            type="checkbox"
            checked={indexed}
            onChange={(e) => { setIndexed(e.target.checked); }}
            className="accent-[var(--color-accent)]"
          />
          <span className="font-mono text-ink font-medium">users.id index</span>
        </label>
        <span className="hidden h-5 w-px bg-edge sm:inline-block" aria-hidden="true" />
        <span className="font-mono text-[0.72rem] uppercase tracking-wider text-ink-dim/80">Rules:</span>
        {OPTIMIZER_RULES.map((name) => (
          <label key={name} className="flex items-center gap-2 text-ink-dim cursor-pointer select-none">
            <input
              type="checkbox"
              checked={rules.has(name)}
              onChange={() => { toggleRule(name); }}
              className="accent-[var(--color-accent)]"
            />
            <span className="font-mono text-[0.8rem] text-ink">{name}</span>
          </label>
        ))}
      </div>

      {/* Metrics Strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          {
            label: 'Fired Rules',
            value: `${plans ? plans.firedRules.size : 0} / ${rules.size}`,
            sub: 'active rewrites',
            color: 'text-accent',
          },
          { label: 'Index Path', value: indexed ? 'Index Scan' : 'Seq Scan Only', sub: 'users.id index' },
          {
            label: 'Optimization',
            value: plans ? (plans.firedRules.size > 0 ? 'Rewritten' : 'Unchanged') : 'Error',
            sub: 'plan status',
            color: plans && plans.firedRules.size > 0 ? 'text-hit' : 'text-ink-dim',
          },
          { label: 'Available Tables', value: 'users, authors', sub: '+ posts table' },
        ].map((m) => (
          <div key={m.label} className="ql-sheen rounded-xl border border-edge bg-surface-2/60 p-3 shadow-neu-rest backdrop-blur-sm">
            <span className="block font-mono text-[0.7rem] uppercase tracking-wider text-ink-dim">{m.label}</span>
            <span className={`mt-1 block truncate text-heading font-semibold tabular-nums ${m.color ?? 'text-ink'}`}>
              {m.value}
            </span>
            <span className="text-[0.75rem] text-ink-dim">{m.sub}</span>
          </div>
        ))}
      </div>

      {validation.error ? (
        <div className="rounded-xl border border-evict/40 bg-evict/10 p-4">
          <p className="text-label font-medium text-ink">{validation.error.message}</p>
          {validation.error.hint && (
            <p className="mt-1 text-label text-ink-dim">{validation.error.hint}</p>
          )}
        </div>
      ) : plans ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <figure className={`${panelSurface} flex min-h-64 flex-col p-4`}>
              <figcaption className="mb-2.5 flex items-center justify-between text-label font-mono text-ink-dim border-b border-edge/60 pb-2">
                <span className="font-semibold text-ink uppercase tracking-wider text-[0.75rem]">Canonical Plan</span>
                <span className="text-[0.7rem] text-ink-dim/70">unoptimized AST fold</span>
              </figcaption>
              <div className="min-h-0 flex-1">
                <PlanTree root={plans.canonical} empty="&mdash;" />
              </div>
            </figure>

            <figure className={`${panelSurface} flex min-h-64 flex-col p-4`}>
              <figcaption className="mb-2.5 flex items-center justify-between text-label font-mono text-ink-dim border-b border-edge/60 pb-2">
                <span className="font-semibold text-ink uppercase tracking-wider text-[0.75rem]">Optimized Plan</span>
                <span className="text-[0.7rem] text-ink-dim/70">
                  {plans.firedRules.size === 0 ? 'unchanged' : `${plans.firedRules.size} rules fired`}
                </span>
              </figcaption>
              <div className="min-h-0 flex-1">
                <PlanTree root={plans.optimised} empty="&mdash;" />
              </div>
            </figure>
          </div>

          <div className="ql-sheen rounded-xl border border-edge bg-surface-2/80 p-4 shadow-neu-rest backdrop-blur-md">
            <h3 className="mb-3 font-mono text-[0.75rem] uppercase tracking-wider text-ink-dim">
              Optimizer Rule Verification
            </h3>
            <ul className="flex flex-col gap-2">
              {OPTIMIZER_RULES.map((name) => {
                const off = !rules.has(name);
                const fired = plans.firedRules.has(name);
                const step = plans.steps.find((s) => s.rule === name);
                return (
                  <li key={name} className="flex flex-col gap-1 text-label leading-relaxed">
                    <div className="flex items-center gap-2.5">
                      <span
                        aria-hidden="true"
                        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.68rem] uppercase tracking-wider ${
                          off
                            ? 'border border-edge/60 bg-surface-3 text-ink-dim/50'
                            : fired
                              ? 'border border-hit/40 bg-hit/10 text-hit'
                              : 'border border-edge bg-surface-2 text-ink-dim'
                        }`}
                      >
                        {off ? 'off' : fired ? 'fired' : 'skip'}
                      </span>
                      <span className={off ? 'text-ink-dim/60' : 'text-ink-dim'}>
                        <span className="font-mono text-ink font-medium">{name}</span>
                        {' — '}
                        {off
                          ? 'rule disabled'
                          : fired && step
                            ? step.label
                            : 'no candidate pattern matched on this plan'}
                      </span>
                    </div>
                    {!off && fired && step?.whyNot && (
                      <div className="pl-6 mt-1">
                        <WhyNotNote whyNot={step.whyNot} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      ) : (
        <p className="text-label text-ink-dim">Type a query to see its plan.</p>
      )}

      <p className="text-label leading-relaxed text-ink-dim">
        The same rewrites run in the pipeline &mdash; step them one event at a time on{' '}
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
