import { useMemo, useState, type CSSProperties } from 'react';
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
  resolveExists,
  resolveStatementSubqueries,
  renamesOf,
  runQuery,
  scopedDatabase,
  toPlanDisplay,
} from '../../engine/index.ts';
import type { Database, Plan, PlanNode, Table } from '../../engine/index.ts';
import { PlanTree } from '../../ui/panels/PlanTree.tsx';
import { btnGhost, controlLabel, inputField, panelSurface } from '../../ui/primitives.ts';
import { WhyNotNote } from '../../ui/WhyNotNote.tsx';
import { useAddressBarQuery } from '../../ui/addressBar.ts';
import {
  ControlGroup,
  Inspector,
  ScenarioPicker,
  StagePanel,
  Switch,
  ToolHeader,
  ToolSection,
  ToolShell,
  useMediaQuery,
} from '../../ui/tool/index.ts';

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
 * Laid out on the tool workbench (`src/ui/tool/`): the index and the rules in the inspector (a checklist with All
 * and None, each marked when it fires), the query in the command region with a menu of examples, both plans side by
 * side on the stage, and what each rule did as a section below. No readout: which rules fired is marked in the
 * checklist and the optimized plan's caption, and a readout would only push the plans down.
 *
 * URL state: `q` (the query), `idx` (`1`/`0`, the index), `rules` (a
 * comma-separated subset of the rule names). All parsed defensively.
 */

const DEFAULT_SQL = 'SELECT name, email\nFROM users\nWHERE id = 5 AND age > 30';
const MAX_SQL = 2000;
/** On a phone, a plan is never framed smaller than this on its own: it pans instead of its nodes running together. */
const PHONE_MIN_ZOOM = 0.7;

/** Starting points, each one a rule's worked example. Editing the SQL reads "Custom". */
const EXAMPLES: readonly { id: string; title: string; blurb: string; sql: string }[] = [
  { id: 'point', title: 'An indexed lookup', blurb: 'The predicate is pushed down, and the index turns the scan into a B+Tree lookup.', sql: DEFAULT_SQL },
  {
    id: 'fold',
    title: 'Constant folding',
    blurb: 'An always-true 1 = 1 is folded out of the predicate before anything else looks at it.',
    sql: 'SELECT * FROM users WHERE 1 = 1 AND id = 5',
  },
  { id: 'range', title: 'A range', blurb: 'A range on the indexed column: the index finds where the range starts.', sql: 'SELECT name FROM users WHERE id > 7' },
  {
    id: 'join',
    title: 'A join',
    blurb: 'Two tables: the canonical plan nests loops, and the cost model picks a cheaper join algorithm.',
    sql: 'SELECT authors.name, posts.title\nFROM authors JOIN posts ON authors.id = posts.authorId',
  },
  {
    id: 'anti',
    title: 'NOT EXISTS',
    blurb: 'A correlated NOT EXISTS becomes an anti-join, whose algorithm is chosen by cost like any other.',
    sql: 'SELECT name FROM authors\nWHERE NOT EXISTS (SELECT * FROM posts WHERE posts.authorId = authors.id)',
  },
];

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

function planDepth(node: PlanNode | null): number {
  if (!node) return 0;
  const kids = node.children ?? [];
  return kids.length === 0 ? 1 : 1 + Math.max(...kids.map(planDepth));
}

/**
 * Both trees' panels share one height, sized for the deeper tree: at a fixed 16rem the deeper canonical tree was
 * fitted down to unreadable and the taller optimized nodes clipped. A plan is a narrow chain, so height is what
 * limits the fit at every width, phones included.
 */
function treeHeight(a: PlanNode | null, b: PlanNode | null): CSSProperties {
  const rows = Math.max(planDepth(a), planDepth(b));
  return { '--tree-h': `${String(Math.min(560, Math.max(256, rows * 120 + 64)))}px` } as CSSProperties;
}

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
    // Every subquery runs first, as in the Playground's pipeline, so the two never draw a different plan for one
    // query: an `IN (subquery)` becomes its list, a scalar one its value (plan.md §27.5 S6), and an EXISTS a semi- or
    // anti-join, or a fact found once (S1).
    const run = (s: string) => runQuery(s, db, DEFAULT_ENGINE_OPTIONS);
    const subqueries = resolveStatementSubqueries(parsed.ast, sql, run);
    if (!subqueries.ok) return null;
    const resolved = resolveExists(subqueries.value, run);
    if (!resolved.ok) return null;
    const ast = resolved.value;
    // The rules and the cost model both key off the table the query is
    // actually against — `users` by default, but `authors`/`posts` once a
    // typed query names one of those instead (plan.md §22.2's JOIN) — each by the
    // name the query gives it, an alias included (plan.md §27.5 S7).
    const scoped = scopedDatabase(parsed.ast, db);
    const fromTable = scoped.tables[ast.from.name] ?? table;
    const canonical = buildPlan(ast);
    const rpp = DEFAULT_ENGINE_OPTIONS.rowsPerPage;
    const steps = optimize(canonical, fromTable, rpp, scoped.tables, rules);
    const last = steps.at(-1);
    const optimised = last ? last.plan : canonical;
    const lastChanged: ReadonlySet<Plan> = last ? last.changed : new Set<Plan>();
    return {
      canonical: toPlanDisplay(canonical, new Set<Plan>(), estimatePlan(canonical, fromTable, rpp, scoped.tables), renamesOf(Object.values(scoped.tables))),
      optimised: toPlanDisplay(optimised, lastChanged, estimatePlan(optimised, fromTable, rpp, scoped.tables), renamesOf(Object.values(scoped.tables))),
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

  const example = EXAMPLES.find((x) => x.sql === sql);
  const phone = !useMediaQuery('(min-width: 640px)');
  const fired = plans ? plans.firedRules.size : 0;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col p-4 sm:p-6 lg:p-8">
      <ToolShell
        category="query"
        header={
          <ToolHeader
            id="planner"
            title="Planner sandbox"
            summary="Turn the optimizer's rewrite rules on and off, and compare the plan it starts from with the one it ends on."
            about={
              <>
                <p>
                  A query&rsquo;s plan is a tree of operators, and the optimizer rewrites it with heuristic rules. Each
                  node carries the cost model&rsquo;s row estimate. Queries can use{' '}
                  <code className="font-mono text-ink">users</code>, and{' '}
                  <code className="font-mono text-ink">authors</code> and <code className="font-mono text-ink">posts</code>{' '}
                  for a <code className="font-mono text-ink">JOIN</code>; only <code className="font-mono text-ink">users</code>{' '}
                  has the index you can turn off.
                </p>
                <p>
                  The same rewrites run in the pipeline. Step them one event at a time on{' '}
                  <Link to="/stages/optimize" className="underline underline-offset-2 hover:text-ink">
                    the optimize stage
                  </Link>
                  , or see what they cost in{' '}
                  <Link to="/compare" className="underline underline-offset-2 hover:text-ink">
                    Compare
                  </Link>
                  .
                </p>
              </>
            }
          />
        }
        inspector={
          <Inspector summary={`${String(rules.size)} of ${String(OPTIMIZER_RULES.length)} rules · index ${indexed ? 'on' : 'off'}`}>
            <ControlGroup legend="Table">
              <Switch id="planner-index" checked={indexed} onChange={setIndexed} label="users has an index on id" />
            </ControlGroup>
            <ControlGroup legend="Rewrite rules" count={rules.size}>
              <div className="flex gap-1">
                <button type="button" className={`${btnGhost} px-2!`} onClick={() => { setRules(new Set(OPTIMIZER_RULES)); }} disabled={rules.size === OPTIMIZER_RULES.length}>
                  All
                </button>
                <button type="button" className={`${btnGhost} px-2!`} onClick={() => { setRules(new Set()); }} disabled={rules.size === 0}>
                  None
                </button>
              </div>
              <ul className="flex flex-col gap-1.5">
                {OPTIMIZER_RULES.map((name) => (
                  <li key={name} className="flex min-w-0 items-center gap-2">
                    <label className="flex min-w-0 cursor-pointer items-center gap-2 text-label text-ink select-none">
                      <input
                        type="checkbox"
                        checked={rules.has(name)}
                        onChange={() => { toggleRule(name); }}
                        className="accent-[var(--stage)]"
                      />
                      <span className="min-w-0 font-mono break-all">{name}</span>
                    </label>
                    {plans?.firedRules.has(name) && (
                      <span className="ml-auto shrink-0 rounded-full border border-hit/40 px-1.5 text-[0.68rem] text-hit">fired</span>
                    )}
                  </li>
                ))}
              </ul>
            </ControlGroup>
          </Inspector>
        }
        command={
          <div className={`${panelSurface} grid min-w-0 gap-4 p-4 xl:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]`}>
            <ScenarioPicker
              id="planner-example"
              label="Example"
              scenarios={EXAMPLES}
              value={example?.id ?? null}
              onPick={(id) => {
                const picked = EXAMPLES.find((x) => x.id === id);
                if (picked) setSql(picked.sql);
              }}
            />
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor="q" className={`flex items-baseline justify-between gap-2 ${controlLabel}`}>
                SQL query
                <span className="font-mono text-ink-dim/80">users · authors · posts</span>
              </label>
              <textarea
                id="q"
                value={sql}
                onChange={(e) => { setSql(e.target.value.slice(0, MAX_SQL)); }}
                rows={3}
                spellCheck={false}
                className={`${inputField} w-full resize-y font-mono`}
              />
            </div>
          </div>
        }
        stage={
          <StagePanel title="Plans" legend="Canonical, as the query is written; optimized, after every rule that is on.">
            {validation.error ? (
              <div className="rounded-xl border border-evict/40 bg-evict/10 p-4">
                <p className="text-label font-medium text-ink">{validation.error.message}</p>
                {validation.error.hint && <p className="mt-1 text-label text-ink-dim">{validation.error.hint}</p>}
              </div>
            ) : plans ? (
              <div className="grid flex-1 gap-4 md:grid-cols-2" style={treeHeight(plans.canonical, plans.optimised)}>
                <figure className="flex min-h-(--tree-h) min-w-0 flex-col rounded-lg border border-edge/70 p-3">
                  <figcaption className="mb-2 border-b border-edge/60 pb-2 text-label font-semibold text-ink">canonical</figcaption>
                  <div className="min-h-0 flex-1">
                    <PlanTree root={plans.canonical} empty="—" minZoom={phone ? PHONE_MIN_ZOOM : undefined} />
                  </div>
                </figure>
                <figure className="flex min-h-(--tree-h) min-w-0 flex-col rounded-lg border border-edge/70 p-3">
                  <figcaption className="mb-2 flex items-baseline justify-between gap-2 border-b border-edge/60 pb-2 text-label">
                    <span className="font-semibold text-ink">optimized{fired === 0 && ' · unchanged'}</span>
                    {fired > 0 && <span className="text-ink-dim">{fired} rule{fired === 1 ? '' : 's'} fired</span>}
                  </figcaption>
                  <div className="min-h-0 flex-1">
                    <PlanTree root={plans.optimised} empty="—" minZoom={phone ? PHONE_MIN_ZOOM : undefined} />
                  </div>
                </figure>
              </div>
            ) : (
              <p className="text-label text-ink-dim">Type a query to see its plan.</p>
            )}
          </StagePanel>
        }
      >
        {plans && (
          <ToolSection title="What each rule did" description="In the order the optimizer tries them. A rule that is on but found nothing to rewrite says so.">
            <ul className="flex flex-col gap-2">
              {OPTIMIZER_RULES.map((name) => {
                const off = !rules.has(name);
                const didFire = plans.firedRules.has(name);
                const step = plans.steps.find((x) => x.rule === name);
                return (
                  <li key={name} className="flex flex-col gap-1 text-label leading-relaxed">
                    <div className="flex items-start gap-2.5">
                      <span
                        aria-hidden="true"
                        className={`mt-0.5 w-12 shrink-0 rounded px-1.5 py-0.5 text-center text-[0.68rem] ${
                          off
                            ? 'border border-edge/60 bg-surface-3 text-ink-dim/60'
                            : didFire
                              ? 'border border-hit/40 bg-hit/10 text-hit'
                              : 'border border-edge bg-surface-2 text-ink-dim'
                        }`}
                      >
                        {off ? 'off' : didFire ? 'fired' : 'skip'}
                      </span>
                      <span className={off ? 'text-ink-dim/70' : 'text-ink-dim'}>
                        <span className="font-mono font-medium text-ink">{name}</span>
                        {' — '}
                        {off ? 'turned off' : didFire && step ? step.label : 'no match on this plan'}
                      </span>
                    </div>
                    {!off && didFire && step?.whyNot && (
                      <div className="mt-1 pl-[3.625rem]">
                        <WhyNotNote whyNot={step.whyNot} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </ToolSection>
        )}
      </ToolShell>
    </div>
  );
}
