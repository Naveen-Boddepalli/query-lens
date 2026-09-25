/**
 * `fast-check` generators for the oracle (plan.md §25.4 A1): typed tables and
 * grammar-derived statements over them.
 *
 * The data is deliberately *small and collision-heavy* — few distinct values,
 * many NULLs, keys that overlap between two tables — because the bugs an
 * oracle finds live at the edges (ties, NULL keys, empty results, empty
 * tables), not in large random tables where every edge is diluted.
 */

import fc from 'fast-check';
import type { EngineOptions, ReplacementPolicyName, Row, SqlValue } from '../src/engine/types.ts';
import type { AggItem, Arith, ArithOp, ColSpec, ColType, Op, Pred, Query, ReadQuery, Ref, TableSpec, WriteQuery } from './model.ts';

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

/** ASCII only: SQLite's BINARY collation is byte order, JavaScript's `<` is UTF-16 code-unit order — the same on ASCII, different beyond it. */
const TEXT_POOL = ['', 'a', 'ab', 'abc', 'b', 'ba', 'c', "it's", 'Z', 'zz'] as const;

const nullable = <T>(arb: fc.Arbitrary<T>, freq = 5): fc.Arbitrary<T | null> => fc.option(arb, { nil: null, freq });

const T_COLUMNS: ColSpec[] = [
  { name: 'id', type: 'int' },
  { name: 'k', type: 'int' },
  { name: 'n', type: 'int' },
  { name: 's', type: 'text' },
  { name: 'r', type: 'real' },
];
const U_COLUMNS: ColSpec[] = [
  { name: 'id', type: 'int' },
  { name: 't_id', type: 'int' },
  { name: 'v', type: 'text' },
  { name: 'w', type: 'real' },
];

/** Quarter-steps from -2 to 4: exact in binary, so sums and products agree bit for bit in both engines. */
const quarter = fc.integer({ min: -8, max: 16 }).map((x) => x / 4);

const columnArray = <T>(arb: fc.Arbitrary<T>, n: number) => fc.array(arb, { minLength: n, maxLength: n });

/**
 * `t(id, k, n, s, r)` — `id` and `k` start out unique and `k` is sometimes NULL; `n`, `s` and `r` repeat freely.
 * Any of them may be indexed: an index over a column that repeats (plan.md §25.4 B3) is a case the oracle checks
 * like any other, since SQLite answers the same lookups from an index of its own.
 */
export const tableT: fc.Arbitrary<TableSpec> = fc.integer({ min: 0, max: 24 }).chain((count) =>
  fc
    .record({
      ids: fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { minLength: count, maxLength: count }),
      ks: fc.uniqueArray(fc.integer({ min: 0, max: 80 }), { minLength: count, maxLength: count }),
      kNull: columnArray(fc.integer({ min: 0, max: 4 }).map((x) => x === 0), count),
      ns: columnArray(nullable(fc.integer({ min: -5, max: 9 })), count),
      ss: columnArray(nullable(fc.constantFrom(...TEXT_POOL)), count),
      rs: columnArray(nullable(quarter), count),
      composite: fc.oneof(
        { weight: 5, arbitrary: fc.constant<string[][]>([]) },
        { weight: 6, arbitrary: fc.constantFrom<string[][]>([['n', 's']], [['s', 'n']], [['n', 'r']], [['r', 'n']], [['id', 'n']], [['k', 's']], [['s', 'r']]) },
        { weight: 2, arbitrary: fc.constantFrom<string[][]>([['n', 's', 'r']], [['s', 'n', 'r']], [['n', 's'], ['s', 'n']], [['n', 'r'], ['n', 's']]) },
      ),
      indexed: fc
        .oneof(
          { weight: 2, arbitrary: fc.subarray(['id', 'k']) },
          { weight: 1, arbitrary: fc.constant(['id']) },
          { weight: 1, arbitrary: fc.constant(['id', 'k']) },
          // A column that repeats: `n` (small ints, some NULL), `s` (a text pool), `r` (quarter-steps).
          { weight: 4, arbitrary: fc.subarray(['id', 'k', 'n', 's', 'r'], { minLength: 1 }) },
          { weight: 2, arbitrary: fc.constantFrom(['n'], ['s'], ['r'], ['n', 's']) },
        )
        .map((cols) => [...cols]),
    })
    .map(({ ids, ks, kNull, ns, ss, rs, indexed, composite }): TableSpec => ({
      name: 't',
      columns: T_COLUMNS,
      rows: ids.map(
        (id, i): Row => ({ id, k: kNull[i] ? null : ks[i], n: ns[i]!, s: ss[i]!, r: rs[i]! }),
      ),
      indexed,
      ...(composite.length > 0 ? { composite } : {}),
    })),
);

/**
 * `u(id, t_id, v, w)` — `t_id` is a non-unique foreign-key shape. Mostly it
 * points at ids `t` really holds (so a join finds partners), sometimes at ids
 * it does not, sometimes NULL (which never joins).
 */
export const tableU = (t: TableSpec): fc.Arbitrary<TableSpec> => {
  const held = t.rows.map((r) => r.id).filter((id): id is number => typeof id === 'number');
  const tId = fc.oneof(
    { weight: held.length > 0 ? 4 : 0, arbitrary: held.length > 0 ? fc.constantFrom(...held) : fc.constant(0) },
    { weight: 1, arbitrary: fc.integer({ min: 1, max: 40 }) },
  );
  return fc.integer({ min: 0, max: 20 }).chain((count) =>
    fc
      .record({
        ids: fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { minLength: count, maxLength: count }),
        tIds: columnArray(nullable(tId, 8), count),
        vs: columnArray(nullable(fc.constantFrom(...TEXT_POOL)), count),
        ws: columnArray(nullable(quarter), count),
        // `t_id` is the foreign-key shape: it repeats, and is the column a join would want an index on.
        indexed: fc.subarray(['id', 't_id', 'v']),
        // A composite index that *leads with* the foreign key can be probed by a join (plan.md §25.4 B3b/B4).
        composite: fc.oneof(
          { weight: 3, arbitrary: fc.constant<string[][]>([]) },
          { weight: 2, arbitrary: fc.constantFrom<string[][]>([['t_id', 'v']], [['t_id', 'w']], [['v', 't_id']], [['t_id', 'v', 'w']]) },
        ),
      })
      .map(({ ids, tIds, vs, ws, indexed, composite }): TableSpec => ({
        name: 'u',
        columns: U_COLUMNS,
        rows: ids.map((id, i): Row => ({ id, t_id: tIds[i]!, v: vs[i]!, w: ws[i]! })),
        indexed,
        ...(composite.length > 0 ? { composite } : {}),
      })),
  );
};

/* -------------------------------------------------------------------------- */
/* Predicates                                                                  */
/* -------------------------------------------------------------------------- */

const OPS: Op[] = ['=', '<>', '<', '>', '<=', '>='];
const opArb = fc.constantFrom(...OPS);

const numeric = (t: ColType): boolean => t === 'int' || t === 'real';
/** Two columns may be compared when both are numeric or both are text — mixed-type comparison is a ledger entry, not a generated case. */
const comparable = (a: Ref, b: Ref): boolean => numeric(a.type) === numeric(b.type);

/** The non-NULL values a column currently holds — literals drawn from these make `=` and ranges actually *hit* rows. */
export type Pool = (ref: Pick<Ref, 'name' | 'table'>) => readonly SqlValue[];

export function poolOf(tables: readonly TableSpec[]): Pool {
  return (ref) => {
    const table = ref.table ? tables.find((t) => t.name === ref.table) : tables[0];
    return table ? table.rows.map((r) => r[ref.name] ?? null).filter((v): v is Exclude<SqlValue, null> => v !== null) : [];
  };
}

function typedLiteral(type: ColType): fc.Arbitrary<SqlValue> {
  return type === 'text'
    ? fc.constantFrom(...TEXT_POOL)
    : type === 'real'
      ? quarter
      : fc.oneof({ weight: 3, arbitrary: fc.integer({ min: -3, max: 9 }) }, { weight: 2, arbitrary: fc.integer({ min: 0, max: 60 }) });
}

/** A literal for comparing against `ref`: usually a value the column holds, sometimes a random one, occasionally NULL. */
function literalFor(ref: Ref, pool: Pool): fc.Arbitrary<SqlValue> {
  const held = pool(ref);
  return fc.oneof(
    { weight: 5, arbitrary: typedLiteral(ref.type) },
    { weight: held.length > 0 ? 6 : 0, arbitrary: held.length > 0 ? fc.constantFrom(...held) : fc.constant(null) },
    { weight: 1, arbitrary: fc.constant(null) },
  );
}

/** A literal to *assign* (UPDATE … SET): no pool, only the type. */
const literalArb = (type: ColType): fc.Arbitrary<SqlValue> =>
  fc.oneof({ weight: 12, arbitrary: typedLiteral(type) }, { weight: 1, arbitrary: fc.constant(null) });

/**
 * An arithmetic tree over `refs`. With `divide` it is built from *integers only*
 * and may use `/` and `%`: that is where the two engines define the same thing
 * (whole-number division truncates toward zero; `x / 0` and `x % 0` are NULL).
 * Without it, reals may mix in but only `+ - *` are used — QueryLens's numbers
 * carry no int/real distinction, so `real / int` is a ledger entry
 * (`division-of-whole-reals`), not a generated case.
 */
export function arithArb(refs: readonly Ref[], { divide }: { divide: boolean }, depth = 2): fc.Arbitrary<Arith> {
  const usable = refs.filter((r) => (divide ? r.type === 'int' : numeric(r.type)));
  // Zero and negatives are where arithmetic differs between implementations (`x / 0`, `-7 % 3`), so they are over-drawn.
  const smallInt = fc.oneof({ weight: 1, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: -5, max: -1 }) }, { weight: 4, arbitrary: fc.integer({ min: 1, max: 9 }) });
  const leaf: fc.Arbitrary<Arith> = fc.oneof(
    ...(usable.length > 0
      ? [{ weight: 3, arbitrary: fc.constantFrom(...usable).map((ref): Arith => ({ k: 'col', ref })) }]
      : []),
    { weight: 2, arbitrary: smallInt.map((v): Arith => ({ k: 'lit', v })) },
    ...(divide ? [] : [{ weight: 1, arbitrary: quarter.map((v): Arith => ({ k: 'lit', v })) }]),
  );
  if (depth <= 0) return leaf;
  const sub = arithArb(refs, { divide }, depth - 1);
  const ops: ArithOp[] = divide ? ['+', '-', '*', '/', '%', '/', '%'] : ['+', '-', '*'];
  return fc.oneof(
    { weight: 3, arbitrary: leaf },
    { weight: 4, arbitrary: fc.tuple(fc.constantFrom(...ops), sub, sub).map(([op, a, b]): Arith => ({ k: 'bin', op, a, b })) },
    { weight: 1, arbitrary: sub.map((a): Arith => ({ k: 'neg', a })) },
  );
}

const computedArb = (refs: readonly Ref[]): fc.Arbitrary<{ e: Arith; alias: string }[]> =>
  fc
    .array(fc.boolean().chain((divide) => arithArb(refs, { divide })), { minLength: 0, maxLength: 2 })
    .map((es) => es.map((e, i) => ({ e, alias: `x${i}` })));

const LIKE_PATTERNS = ['a%', '%a', '_b', 'a_c', '%b%', '%', 'ab', '', 'z%', 'Z%', '_', '__', '%_', "it%", "i_'s", 'b_', '%z'] as const;

/** A leaf predicate: one comparison or one test on a column (or two literals). */
function leafArb(refs: readonly Ref[], pool: Pool): fc.Arbitrary<Pred> {
  const refArb = fc.constantFrom(...refs);
  const cmp = fc
    .tuple(refArb, opArb)
    .chain(([ref, op]) => literalFor(ref, pool).map((lit): Pred => ({ k: 'cmp', ref, op, lit })));
  const between = fc
    .tuple(refArb, fc.boolean())
    .chain(([ref, neg]) =>
      fc.tuple(literalFor(ref, pool), literalFor(ref, pool)).map(([lo, hi]): Pred => ({ k: 'between', ref, lo, hi, neg })),
    );
  // `a` against itself is included on purpose: `n = n` is UNKNOWN when `n` is NULL, not TRUE.
  const pairs = refs.flatMap((a) => refs.filter((b) => comparable(a, b)).map((b) => [a, b] as const));
  const colcmp =
    pairs.length === 0
      ? []
      : [
          {
            weight: 2,
            arbitrary: fc
              .tuple(fc.constantFrom(...pairs), opArb)
              .map(([[a, b], op]): Pred => ({ k: 'colcmp', a, op, b })),
          },
        ];
  const litcmp = fc
    .tuple(fc.constantFrom<ColType>('int', 'text'), opArb)
    .chain(([type, op]) => fc.tuple(literalArb(type), literalArb(type)).map(([a, b]): Pred => ({ k: 'litcmp', a, op, b })));
  const acmp = fc
    .tuple(fc.boolean().chain((divide) => arithArb(refs, { divide }, 2)), opArb, literalArb('int'))
    .map(([e, op, lit]): Pred => ({ k: 'acmp', e, op, lit }));
  const numericRefs = refs.filter((r) => numeric(r.type));
  const ccmp =
    numericRefs.length === 0
      ? []
      : [
          {
            weight: 2,
            arbitrary: fc
              .tuple(fc.constantFrom(...numericRefs), opArb, fc.boolean().chain((divide) => arithArb([], { divide }, 2)))
              .map(([ref, op, e]): Pred => ({ k: 'ccmp', ref, op, e })),
          },
        ];
  const isnull = fc.tuple(refArb, fc.boolean()).map(([ref, neg]): Pred => ({ k: 'isnull', ref, neg }));
  // IN's list may hold a NULL (literalFor allows one) — `x NOT IN (1, NULL)` is the classic trap.
  const inList = fc
    .tuple(refArb, fc.boolean())
    .chain(([ref, neg]) =>
      fc.array(literalFor(ref, pool), { minLength: 1, maxLength: 4 }).map((list): Pred => ({ k: 'in', ref, list, neg })),
    );
  const textRefs = refs.filter((r) => r.type === 'text');
  const like =
    textRefs.length === 0
      ? []
      : [
          {
            weight: 2,
            arbitrary: fc
              .tuple(fc.constantFrom(...textRefs), fc.constantFrom(...LIKE_PATTERNS), fc.boolean())
              .map(([ref, pattern, neg]): Pred => ({ k: 'like', ref, pattern, neg })),
          },
        ];
  return fc.oneof(
    { weight: 6, arbitrary: cmp },
    { weight: 2, arbitrary: between },
    { weight: 1, arbitrary: litcmp },
    { weight: 2, arbitrary: isnull },
    { weight: 2, arbitrary: acmp },
    ...ccmp,
    { weight: 2, arbitrary: inList },
    ...like,
    ...colcmp,
  );
}

/** A predicate tree at most `depth` levels of `AND` / `OR` / `NOT` deep. */
export function predArb(refs: readonly Ref[], pool: Pool, depth = 2): fc.Arbitrary<Pred> {
  const leaf = leafArb(refs, pool);
  if (depth <= 0) return leaf;
  const sub = predArb(refs, pool, depth - 1);
  return fc.oneof(
    { weight: 6, arbitrary: leaf },
    { weight: 1, arbitrary: fc.tuple(sub, sub).map(([a, b]): Pred => ({ k: 'or', a, b })) },
    { weight: 1, arbitrary: fc.tuple(sub, sub).map(([a, b]): Pred => ({ k: 'and', a, b })) },
    { weight: 1, arbitrary: sub.map((p): Pred => ({ k: 'not', p })) },
  );
}

/**
 * Zero predicates two times in five — an over-constrained WHERE returns nothing, and an empty answer tests
 * very little. Every new predicate form makes an empty answer likelier, so this weight is what keeps the
 * generators' non-empty share (asserted in `coverage.test.ts`) from eroding as the SQL grows.
 */
const whereArb = (refs: readonly Ref[], pool: Pool, max = 3): fc.Arbitrary<Pred[]> =>
  fc.oneof(
    { weight: 2, arbitrary: fc.constant<Pred[]>([]) },
    { weight: 3, arbitrary: fc.array(predArb(refs, pool), { minLength: 1, maxLength: max }) },
  );

/* -------------------------------------------------------------------------- */
/* Read statements                                                             */
/* -------------------------------------------------------------------------- */

export function refsOf(table: TableSpec, qualify: boolean): Ref[] {
  return table.columns.map((c) => ({ name: c.name, type: c.type, ...(qualify ? { table: table.name } : {}) }));
}

/** A page: no limit, a limit, or a limit with an offset — `OFFSET` never appears without a `LIMIT`, as in SQLite. */
const pageArb: fc.Arbitrary<{ limit?: number; offset?: number }> = fc.oneof(
  { weight: 5, arbitrary: fc.constant<{ limit?: number; offset?: number }>({}) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 8 }).map((limit) => ({ limit })) },
  // Small offsets: a big one just returns nothing, and an empty answer tests very little.
  {
    weight: 2,
    arbitrary: fc.tuple(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 3 })).map(([limit, offset]) => ({ limit, offset })),
  },
);
const uniqueRefs = (refs: readonly Ref[], min: number, max: number) =>
  fc.uniqueArray(fc.constantFrom(...refs), { minLength: min, maxLength: max, selector: (r) => r.name + (r.table ?? '') });

/**
 * The shapes an index answers: `WHERE id = <held id>` (with the projections
 * that make it an index-only scan), and a range on `id` / `k`. Random
 * predicates almost never produce these on their own, so without a dedicated
 * shape the optimizer's index rules would go unexercised — `coverage.test.ts`
 * fails the build if they do.
 */
function lookupArb(t: TableSpec, pool: Pool): fc.Arbitrary<Query> {
  const refs = refsOf(t, false);
  const ref = (name: string) => refs.find((r) => r.name === name)!;
  // The columns the table is actually indexed on — including ones that repeat (plan.md §25.4 B3) — else `id`/`k`.
  const indexed = (t.indexed.length > 0 ? t.indexed : ['id', 'k']).map(ref);
  const repeating = indexed.filter((r) => r.name !== 'id' && r.name !== 'k');
  // A column that repeats is where an equality returns several rows, so lean toward it when the table has one indexed.
  const key =
    repeating.length > 0
      ? fc.oneof({ weight: 3, arbitrary: fc.constantFrom(...repeating) }, { weight: 1, arbitrary: fc.constantFrom(...indexed) })
      : fc.constantFrom(...indexed);
  const projection = fc.oneof(
    { weight: 5, arbitrary: key.map((k): Ref[] => [k]) },
    { weight: 2, arbitrary: fc.constant<Ref[] | '*'>('*') },
    { weight: 2, arbitrary: uniqueRefs(refs, 1, 3) },
  );
  const keyPred = key.chain((k) =>
    fc.oneof(
      { weight: 4, arbitrary: literalFor(k, pool).map((lit): Pred => ({ k: 'cmp', ref: k, op: '=', lit })) },
      { weight: 2, arbitrary: fc.tuple(literalFor(k, pool), literalFor(k, pool)).map(([lo, hi]): Pred => ({ k: 'between', ref: k, lo, hi })) },
      { weight: 2, arbitrary: fc.tuple(opArb, literalFor(k, pool)).map(([op, lit]): Pred => ({ k: 'cmp', ref: k, op, lit })) },
    ),
  );
  // Half the time nothing else is checked, so `SELECT id … WHERE id = x` can become an index-only scan.
  const extra = fc.oneof({ weight: 1, arbitrary: fc.constant<Pred[]>([]) }, { weight: 1, arbitrary: whereArb(refs, pool, 1) });
  const single = fc.tuple(projection, keyPred, extra, pageArb).map(
    ([proj, pred, extra, page]): Query => ({
      kind: 'select',
      table: t.name,
      proj,
      where: [pred, ...extra],
      ...page,
    }),
  );
  const composites = t.composite ?? [];
  if (composites.length === 0) return single;

  // Composite indexes (plan.md §25.4 B3b): equalities on a leftmost prefix of the columns (which enters the index), or —
  // one time in six — on the columns *after* the first (which cannot, and must fall back to a scan without changing the
  // answer). Half the projections read only index columns, so the index can cover the query.
  const composite = fc.constantFrom(...composites).chain((columns) => {
    const cols = columns.map(ref);
    return fc
      .record({
        k: fc.integer({ min: 1, max: cols.length }),
        skipLead: fc.integer({ min: 0, max: 5 }).map((x) => x === 0),
      })
      .chain(({ k, skipLead }) => {
        const named = skipLead ? cols.slice(1, Math.max(2, k)) : cols.slice(0, k);
        // Sometimes a range on the column just after the prefix (`a = 1 AND b > 3`): the index narrows it within the run.
        const after = skipLead ? undefined : cols[k];
        const range: fc.Arbitrary<Pred[]> = after
          ? fc.oneof(
              { weight: 1, arbitrary: fc.constant<Pred[]>([]) },
              { weight: 2, arbitrary: fc.tuple(opArb.filter((op) => op !== '=' && op !== '<>'), literalFor(after, pool)).map(([op, lit]): Pred[] => [{ k: 'cmp', ref: after, op, lit }]) },
              { weight: 1, arbitrary: fc.tuple(literalFor(after, pool), literalFor(after, pool)).map(([lo, hi]): Pred[] => [{ k: 'between', ref: after, lo, hi }]) },
            )
          : fc.constant<Pred[]>([]);
        return fc.tuple(
          fc.tuple(...named.map((r) => literalFor(r, pool).map((lit): Pred => ({ k: 'cmp', ref: r, op: '=', lit })))),
          range,
          fc.oneof(
            { weight: 1, arbitrary: uniqueRefs(cols, 1, cols.length) },
            { weight: 1, arbitrary: fc.constant<Ref[] | '*'>('*') },
            { weight: 1, arbitrary: uniqueRefs(refs, 1, 3) },
          ),
          extra,
          pageArb,
        );
      })
      .map(
        ([preds, range, proj, extra, page]): Query => ({
          kind: 'select',
          table: t.name,
          proj,
          where: [...preds, ...range, ...extra],
          ...page,
        }),
      );
  });
  return fc.oneof({ weight: 1, arbitrary: single }, { weight: 2, arbitrary: composite });
}

/**
 * The projection actually rendered. Two adjustments, each a dialect gap rather than a bug:
 * `*` cannot share a list with computed columns (SQLite allows `*, x`; a documented QueryLens limit), and a
 * `SELECT DISTINCT … ORDER BY c` must select `c` (PostgreSQL's rule, which QueryLens enforces; SQLite is lenient).
 */
function fixedProj(
  proj: Ref[] | '*',
  refs: readonly Ref[],
  computed: number,
  order: { ref: Ref } | undefined,
  distinct: boolean,
): Ref[] | '*' {
  if (proj === '*') return computed === 0 ? '*' : [...refs];
  if (distinct && order && !proj.some((r) => r.name === order.ref.name && r.table === order.ref.table)) return [...proj, order.ref];
  return proj;
}

export function selectArb(t: TableSpec, pool: Pool): fc.Arbitrary<Query> {
  const refs = refsOf(t, false);
  const general = fc
    .record({
      proj: fc.oneof({ weight: 1, arbitrary: fc.constant('*' as const) }, { weight: 2, arbitrary: uniqueRefs(refs, 1, 4) }),
      where: whereArb(refs, pool),
      order: fc.option(fc.record({ ref: fc.constantFrom(...refs), dir: fc.constantFrom('asc', 'desc') }), {
        nil: undefined,
        freq: 2,
      }),
      computed: fc.oneof({ weight: 3, arbitrary: fc.constant<{ e: Arith; alias: string }[]>([]) }, { weight: 1, arbitrary: computedArb(refs) }),
      distinct: fc.integer({ min: 0, max: 3 }).map((x) => x === 0),
      // A projection with a unique column (`id`, `k`) can never repeat a row, so DISTINCT on it proves nothing:
      // most DISTINCT queries project only the columns that do repeat.
      dupProj: uniqueRefs(refs.filter((r) => r.name !== 'id' && r.name !== 'k'), 1, 2),
      page: pageArb,
    })
    .map(({ proj: anyProj, dupProj, where, order, computed, distinct, page }): Query => {
      const proj = distinct && dupProj.length > 0 && order === undefined ? dupProj : anyProj;
      return {
      kind: 'select',
      table: t.name,
      // `*` cannot share a SELECT list with anything else in QueryLens (SQLite allows `*, x`; a documented
      // limit, plan.md §25.4 B1b) — so computed columns ride on an explicit list of every column instead.
      proj: fixedProj(proj, refs, computed.length, order, distinct),
      ...(distinct ? { distinct } : {}),
      ...(computed.length > 0 ? { computed } : {}),
      where,
      ...(order ? { order } : {}),
      ...page,
      };
    });
  return fc.oneof({ weight: 3, arbitrary: general }, { weight: 3, arbitrary: lookupArb(t, pool) });
}

export function aggregateArb(t: TableSpec, pool: Pool): fc.Arbitrary<Query> {
  const refs = refsOf(t, false);
  const numericRefs = refs.filter((r) => numeric(r.type));
  const agg: fc.Arbitrary<AggItem> = fc.oneof(
    fc.constant<AggItem>({ fn: 'COUNT', arg: '*' }),
    fc.constantFrom(...refs).map((arg): AggItem => ({ fn: 'COUNT', arg })),
    fc.tuple(fc.constantFrom('SUM', 'AVG'), fc.constantFrom(...numericRefs)).map(([fn, arg]): AggItem => ({ fn, arg })),
    fc.tuple(fc.constantFrom('MIN', 'MAX'), fc.constantFrom(...refs)).map(([fn, arg]): AggItem => ({ fn, arg })),
  );
  const groupCandidates = refs.filter((r) => r.name !== 'r'); // grouping by a REAL is legal but adds nothing the others don't
  // HAVING (plan.md §25.4 B2): a predicate over the groups. Its aggregates need not be in the SELECT list, and its
  // plain columns must be grouped ones — so the leaves are drawn from the group columns chosen *for this query*.
  const havingLeaf = (group: readonly Ref[]): fc.Arbitrary<Pred> =>
    fc.oneof(
      // The literal must be the aggregate's own type: `MIN(text) > 0` is a mixed-type comparison, which the two
      // engines define differently (ledger: `mixed-type-comparison`), and never a generated case.
      {
        weight: 4,
        arbitrary: fc.tuple(agg, opArb).chain(([a, op]) => {
          const text = (a.fn === 'MIN' || a.fn === 'MAX') && a.arg !== '*' && a.arg.type === 'text';
          const lit: fc.Arbitrary<SqlValue> = text
            ? fc.constantFrom(...TEXT_POOL)
            : fc.oneof({ weight: 3, arbitrary: fc.integer({ min: 0, max: 3 }) }, { weight: 1, arbitrary: literalArb('int') });
          return lit.map((l): Pred => ({ k: 'hagg', agg: a, op, lit: l }));
        }),
      },
      ...(group.length === 0
        ? []
        : [{ weight: 2, arbitrary: fc.constantFrom(...group).chain((ref) => fc.tuple(opArb, literalFor(ref, pool)).map(([op, lit]): Pred => ({ k: 'cmp', ref, op, lit }))) }]),
    );
  const havingArb = (group: readonly Ref[]): fc.Arbitrary<Pred | undefined> => {
    const leaf = havingLeaf(group);
    return fc.oneof(
      { weight: 6, arbitrary: fc.constant<Pred | undefined>(undefined) },
      { weight: 2, arbitrary: leaf },
      { weight: 1, arbitrary: fc.tuple(leaf, leaf).map(([a, b]): Pred => ({ k: 'and', a, b })) },
      { weight: 1, arbitrary: fc.tuple(leaf, leaf).map(([a, b]): Pred => ({ k: 'or', a, b })) },
      { weight: 1, arbitrary: leaf.map((p): Pred => ({ k: 'not', p })) },
    );
  };
  return fc
    .record({
      group: uniqueRefs(groupCandidates, 0, 2),
      aggs: fc.uniqueArray(agg, { minLength: 0, maxLength: 3, selector: (a) => `${a.fn}(${a.arg === '*' ? '*' : a.arg.name})` }),
      showAll: fc.boolean(),
      distinct: fc.integer({ min: 0, max: 5 }).map((x) => x === 0),
      where: whereArb(refs, pool, 2),
      page: pageArb,
    })
    .chain((base) => havingArb(base.group).map((having) => ({ ...base, having })))
    .map(({ group, aggs, showAll, distinct, where, having, page }): Query => {
      // A query with no aggregate and no GROUP BY is a plain SELECT — force at least one aggregate then.
      const items = group.length === 0 && aggs.length === 0 ? ([{ fn: 'COUNT', arg: '*' }] as AggItem[]) : aggs;
      return {
        kind: 'aggregate',
        ...(distinct ? { distinct } : {}),
        table: t.name,
        group,
        shownGroup: showAll ? group : group.slice(0, 1),
        aggs: items,
        where,
        ...(having ? { having } : {}),
        ...page,
      };
    });
}

export function joinArb(t: TableSpec, u: TableSpec, pool: Pool): fc.Arbitrary<Query> {
  const tRefs = refsOf(t, true);
  const uRefs = refsOf(u, true);
  const all = [...tRefs, ...uRefs];
  const pairs = tRefs.flatMap((l) => uRefs.filter((r) => comparable(l, r)).map((r) => ({ l, r })));
  return fc
    .record({
      on: fc.constantFrom(...pairs),
      proj: uniqueRefs(all, 1, 5),
      computed: fc.oneof({ weight: 3, arbitrary: fc.constant<{ e: Arith; alias: string }[]>([]) }, { weight: 1, arbitrary: computedArb(all) }),
      distinct: fc.integer({ min: 0, max: 3 }).map((x) => x === 0),
      where: whereArb(all, pool, 2),
      page: pageArb,
    })
    .map(({ on, proj, computed, distinct, where, page }): Query => ({
      kind: 'join',
      ...(distinct ? { distinct } : {}),
      left: t.name,
      right: u.name,
      on,
      proj,
      ...(computed.length > 0 ? { computed } : {}),
      where,
      ...page,
    }));
}

/* -------------------------------------------------------------------------- */
/* Write statements                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `id` and `k` of an INSERT are assigned by `sessionArb` (a serial no existing row uses), so an INSERT keeps them
 * unique the way a key column would be — an index could hold duplicates now (plan.md §25.4 B3), but `id`/`k` are the
 * columns a generated table starts out unique on, and the repeating columns (`n`, `s`, `r`) are where duplicates come from.
 */
const INSERT_COLUMNS = ['id', 'k', 'n', 's', 'r'] as const;

export function insertArb(t: TableSpec): fc.Arbitrary<WriteQuery> {
  return fc
    .tuple(
      fc.option(fc.subarray([...INSERT_COLUMNS], { minLength: 1 }), { nil: undefined, freq: 2 }),
      fc.record({
        n: nullable(fc.integer({ min: -5, max: 9 })),
        s: nullable(fc.constantFrom(...TEXT_POOL)),
        r: nullable(quarter),
      }),
    )
    .map(([subset, v]): WriteQuery => {
      const names = subset ?? [...INSERT_COLUMNS];
      return {
        kind: 'insert',
        table: t.name,
        ...(subset ? { columns: names } : {}),
        // `id` / `k` are placeholders (0) until the session numbers them.
        values: names.map((name) => (name === 'id' || name === 'k' ? 0 : v[name])),
      };
    });
}

/**
 * A `WHERE` for a write: mostly any predicate, but often an equality on an *indexed* column, so the write finds its
 * rows through the index — several of them when the column repeats — and has to maintain that index as it goes.
 */
function writeWhereArb(t: TableSpec, refs: readonly Ref[], pool: Pool): fc.Arbitrary<Pred[]> {
  const general = whereArb(refs, pool, 2);
  const composites = t.composite ?? [];
  if (t.indexed.length === 0 && composites.length === 0) return general;
  const single = t.indexed.length === 0
    ? []
    : [
        fc
          .constantFrom(...t.indexed.map((name) => refs.find((r) => r.name === name)!))
          .chain((ref) => literalFor(ref, pool).map((lit): Pred => ({ k: 'cmp', ref, op: '=', lit })))
          .map((eq): Pred[] => [eq]),
      ];
  // Equalities on a leftmost prefix of a composite index: the write finds its rows through it and maintains it.
  const prefix = composites.map((columns) =>
    fc.integer({ min: 1, max: columns.length }).chain((k) =>
      fc.tuple(
        ...columns.slice(0, k).map((name) => {
          const ref = refs.find((r) => r.name === name)!;
          return literalFor(ref, pool).map((lit): Pred => ({ k: 'cmp', ref, op: '=', lit }));
        }),
      ),
    ),
  );
  const viaIndex = fc
    .oneof(...[...single, ...prefix])
    .chain((eqs) => fc.oneof(fc.constant<Pred[]>(eqs), whereArb(refs, pool, 1).map((rest): Pred[] => [...eqs, ...rest])));
  // A range on an indexed column's leading column (or, for a composite, on the one after an equality prefix): the write
  // walks the leaf chain to find its rows, and must keep the index sound as it changes them.
  const rangeCols = [...t.indexed, ...composites.map((c) => c[0])];
  const viaRange = fc
    .constantFrom(...rangeCols.map((name) => refs.find((r) => r.name === name)!))
    .chain((ref) =>
      fc.oneof(
        { weight: 3, arbitrary: fc.tuple(opArb.filter((op) => op !== '=' && op !== '<>'), literalFor(ref, pool)).map(([op, lit]): Pred[] => [{ k: 'cmp', ref, op, lit }]) },
        { weight: 1, arbitrary: fc.tuple(literalFor(ref, pool), literalFor(ref, pool)).map(([lo, hi]): Pred[] => [{ k: 'between', ref, lo, hi }]) },
      ),
    );
  const viaPrefixRange = composites.map((columns) =>
    fc.tuple(literalFor(refs.find((r) => r.name === columns[0])!, pool), fc.tuple(opArb.filter((op) => op !== '=' && op !== '<>'), literalFor(refs.find((r) => r.name === columns[1])!, pool))).map(
      ([lit, [op, rlit]]): Pred[] => [
        { k: 'cmp', ref: refs.find((r) => r.name === columns[0])!, op: '=', lit },
        { k: 'cmp', ref: refs.find((r) => r.name === columns[1])!, op, lit: rlit },
      ],
    ),
  );
  return fc.oneof(
    { weight: 3, arbitrary: general },
    { weight: 2, arbitrary: viaIndex },
    ...(rangeCols.length > 0 ? [{ weight: 2, arbitrary: viaRange }] : []),
    ...viaPrefixRange.map((arbitrary) => ({ weight: 1, arbitrary })),
  );
}

export function updateArb(t: TableSpec, pool: Pool): fc.Arbitrary<WriteQuery> {
  const refs = refsOf(t, false);
  // Any column but the join key's partner: SET on an *indexed* column moves that row's index entry, which is the point.
  const settable = t.columns.filter((c) => ['id', 'k', 'n', 's', 'r'].includes(c.name));
  return fc
    .record({
      set: fc.uniqueArray(fc.constantFrom(...settable), { minLength: 1, maxLength: 2, selector: (c) => c.name }),
      where: writeWhereArb(t, refs, pool),
    })
    .chain(({ set, where }) =>
      // Each assignment is a literal, or — a third of the time — arithmetic over the row's own columns
      // (`SET n = n + 1`). `n` only ever takes integer arithmetic; `r` may take `+ - *` over reals too.
      fc
        .tuple(
          ...set.map((c) =>
            fc.oneof(
              { weight: 2, arbitrary: literalArb(c.type).map((value) => ({ value, expr: undefined as Arith | undefined })) },
              ...(c.type === 'text'
                ? []
                : [{ weight: 3, arbitrary: arithArb(refs, { divide: c.type === 'int' }, 1).map((expr) => ({ value: null as SqlValue, expr: expr })) }]),
            ),
          ),
        )
        .map(
          (values): WriteQuery => ({
            kind: 'update',
            table: t.name,
            set: set.map((c, i) => ({ col: c.name, value: values[i].value, ...(values[i].expr ? { expr: values[i].expr } : {}) })),
            where,
          }),
        ),
    );
}

export function deleteArb(t: TableSpec, pool: Pool): fc.Arbitrary<WriteQuery> {
  return writeWhereArb(t, refsOf(t, false), pool).map((where): WriteQuery => ({ kind: 'delete', table: t.name, where }));
}

/* -------------------------------------------------------------------------- */
/* A session: the tables, up to three writes, then one read                    */
/* -------------------------------------------------------------------------- */

export interface Session {
  tables: TableSpec[];
  steps: Query[];
}

/** Numbers each INSERT's `id`/`k` from a serial no generated row uses (`id` ≤ 40, `k` ≤ 80). */
function number(steps: Query[]): Query[] {
  return steps.map((q, i) => {
    if (q.kind !== 'insert') return q;
    const names = q.columns ?? [...INSERT_COLUMNS];
    return { ...q, values: q.values.map((v, j) => (names[j] === 'id' ? 100 + i : names[j] === 'k' ? 200 + i : v)) };
  });
}

export const sessionArb = (final: 'select' | 'aggregate' | 'join' | 'any' = 'any'): fc.Arbitrary<Session> =>
  tableT.chain((t) => tableU(t).map((u) => [t, u] as const)).chain(([t, u]) => {
    const pool = poolOf([t, u]);
    const write = fc.oneof(insertArb(t), updateArb(t, pool), deleteArb(t, pool));
    const read: fc.Arbitrary<ReadQuery> = (
      final === 'select'
        ? selectArb(t, pool)
        : final === 'aggregate'
          ? aggregateArb(t, pool)
          : final === 'join'
            ? joinArb(t, u, pool)
            : fc.oneof(selectArb(t, pool), aggregateArb(t, pool), joinArb(t, u, pool))
    ) as fc.Arbitrary<ReadQuery>;
    return fc.tuple(fc.array(write, { minLength: 0, maxLength: 3 }), read).map(([w, r]): Session => ({ tables: [t, u], steps: number([...w, r]) }));
  });

/* -------------------------------------------------------------------------- */
/* Physical configuration                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The knobs that change *how* a query runs and must never change *what* it
 * returns: buffer size, page size, replacement policy, join algorithm,
 * aggregate strategy. Drawn per session so every physical strategy is checked
 * against SQLite, not just the defaults.
 */
export const optionsArb: fc.Arbitrary<EngineOptions> = fc
  .record({
    bufferFrames: fc.integer({ min: 3, max: 12 }),
    rowsPerPage: fc.integer({ min: 1, max: 6 }),
    policy: fc.constantFrom<ReplacementPolicyName>('lru', 'clock'),
    joinStrategy: fc.constantFrom('nested-loop', 'hash', 'sort-merge', 'index-nested-loop'),
    aggregateStrategy: fc.constantFrom('hash', 'sort'),
  });
