/**
 * plan.md §22.3 `/tools/grammar`: a diagram of the v0 SQL subset, generated
 * from data that mirrors `parser.ts`'s own grammar comment — not a separate,
 * hand-maintained description that could quietly drift out of sync with what
 * the parser actually accepts (`GalleryPage`'s discipline: a wrong claim
 * should fail a test, not ship). `__tests__/grammar.test.ts` is the guard:
 * every literal keyword here is checked against the tokenizer's own
 * `KEYWORDS` set, and a representative query built from each rule is run
 * through the real `parseStatement` to confirm it actually parses.
 *
 * Pure data — no DOM, no rendering here. `GrammarToolPage` turns it into the
 * diagram.
 */

export type GrammarPart =
  | { kind: 'literal'; text: string }
  | { kind: 'rule'; name: string }
  | { kind: 'choice'; options: GrammarPart[][] }
  | { kind: 'optional'; parts: GrammarPart[] }
  /** `parts`, repeated, separated by `separator` — e.g. `(',' identifier)*`. */
  | { kind: 'repeat'; separator: GrammarPart; parts: GrammarPart[] };

export interface GrammarRule {
  name: string;
  parts: GrammarPart[];
}

const lit = (text: string): GrammarPart => ({ kind: 'literal', text });
const rule = (name: string): GrammarPart => ({ kind: 'rule', name });
const opt = (...parts: GrammarPart[]): GrammarPart => ({ kind: 'optional', parts });
const choice = (...options: GrammarPart[][]): GrammarPart => ({ kind: 'choice', options });
const repeat = (separator: GrammarPart, ...parts: GrammarPart[]): GrammarPart => ({
  kind: 'repeat',
  separator,
  parts,
});

/**
 * One rule per line of `parser.ts`'s own grammar comment, same order. Keep
 * the two in sync by hand — the test file is what actually enforces it.
 */
export const GRAMMAR: GrammarRule[] = [
  {
    name: 'statement',
    parts: [
      choice([rule('explain')], [rule('analyze')], [rule('select')], [rule('delete')], [rule('insert')], [rule('update')]),
    ],
  },
  { name: 'explain', parts: [lit('EXPLAIN'), opt(lit('ANALYZE')), rule('select')] },
  { name: 'analyze', parts: [lit('ANALYZE'), rule('identifier'), opt(lit(';'))] },
  {
    name: 'select',
    parts: [
      lit('SELECT'),
      opt(lit('DISTINCT')),
      rule('selectList'),
      lit('FROM'),
      rule('identifier'),
      // Zero or more, left-deep (plan.md §25.4 C3 slice b) — concatenated directly, with no separator token
      // between one JOIN clause and the next, unlike every other `repeat` here.
      repeat(opt(), rule('join')),
      opt(lit('WHERE'), rule('expr')),
      // Columns are qualified (`posts.authorId`) in a query with a JOIN, here as everywhere (plan.md §26 Feature 1).
      opt(lit('GROUP'), lit('BY'), rule('qualifiedColumn'), repeat(lit(','), rule('qualifiedColumn'))),
      opt(lit('HAVING'), rule('expr')),
      // An aggregate call sorts the groups (plan.md §26 Feature 1, slice a); the engine then checks the query groups.
      opt(lit('ORDER'), lit('BY'), choice([rule('qualifiedColumn')], [rule('aggregateCall')]), opt(choice([lit('ASC')], [lit('DESC')]))),
      opt(lit('LIMIT'), rule('number'), opt(lit('OFFSET'), rule('number'))),
      opt(lit(';')),
    ],
  },
  {
    name: 'join',
    parts: [
      opt(choice([lit('INNER')], [lit('LEFT'), opt(lit('OUTER'))])),
      lit('JOIN'),
      rule('identifier'),
      lit('ON'),
      rule('qualifiedColumn'),
      lit('='),
      rule('qualifiedColumn'),
    ],
  },
  {
    name: 'delete',
    parts: [lit('DELETE'), lit('FROM'), rule('identifier'), opt(lit('WHERE'), rule('expr')), opt(lit(';'))],
  },
  {
    name: 'insert',
    parts: [
      lit('INSERT'),
      lit('INTO'),
      rule('identifier'),
      opt(rule('columnList')),
      lit('VALUES'),
      rule('valueList'),
      opt(lit(';')),
    ],
  },
  {
    name: 'update',
    parts: [
      lit('UPDATE'),
      rule('identifier'),
      lit('SET'),
      rule('assignment'),
      repeat(lit(','), rule('assignment')),
      opt(lit('WHERE'), rule('expr')),
      opt(lit(';')),
    ],
  },
  { name: 'assignment', parts: [rule('identifier'), lit('='), rule('expr')] },
  { name: 'columnList', parts: [lit('('), rule('identifier'), repeat(lit(','), rule('identifier')), lit(')')] },
  { name: 'valueList', parts: [lit('('), rule('value'), repeat(lit(','), rule('value')), lit(')')] },
  // An INSERT value: a literal, optionally negated. (Arithmetic on literals is accepted too and folded to
  // one value at parse time; a column is rejected — there is no row to read it from.)
  {
    name: 'value',
    parts: [choice([opt(lit('-')), rule('number')], [rule('string')], [lit('NULL')], [lit('TRUE')], [lit('FALSE')])],
  },
  {
    name: 'selectList',
    parts: [choice([lit('*')], [rule('selectItem'), repeat(lit(','), rule('selectItem'))])],
  },
  {
    name: 'selectItem',
    parts: [choice([rule('aggregateCall')], [rule('expr'), opt(lit('AS'), rule('identifier'))])],
  },
  {
    name: 'aggregateCall',
    parts: [
      choice([lit('COUNT')], [lit('SUM')], [lit('AVG')], [lit('MIN')], [lit('MAX')]),
      lit('('),
      choice([lit('*')], [rule('qualifiedColumn')]),
      lit(')'),
    ],
  },
  // A predicate, loosest binding first: OR, then AND, then NOT, then one test on an operand (plan.md §25.4 B1).
  { name: 'expr', parts: [rule('orExpr')] },
  { name: 'orExpr', parts: [rule('andExpr'), repeat(lit('OR'), rule('andExpr'))] },
  { name: 'andExpr', parts: [rule('notExpr'), repeat(lit('AND'), rule('notExpr'))] },
  { name: 'notExpr', parts: [choice([lit('NOT'), rule('notExpr')], [rule('predicate')])] },
  {
    name: 'predicate',
    parts: [
      rule('operand'),
      opt(
        choice(
          [rule('compareOp'), rule('operand')],
          [opt(lit('NOT')), lit('BETWEEN'), rule('operand'), lit('AND'), rule('operand')],
          [lit('IS'), opt(lit('NOT')), lit('NULL')],
          [
            opt(lit('NOT')),
            lit('IN'),
            lit('('),
            choice([rule('operand'), repeat(lit(','), rule('operand'))], [rule('inSubquery')]),
            lit(')'),
          ],
          [opt(lit('NOT')), lit('LIKE'), rule('operand')],
        ),
      ),
    ],
  },
  // The one shape IN accepts besides a literal list (plan.md §25.4 C3 slice c, closing C3) — always exactly one
  // plain column, uncorrelated, and much smaller than `select` itself: no JOIN/GROUP BY/HAVING/ORDER BY/LIMIT/
  // DISTINCT/aggregate, none of which could change *which* values end up in the set IN tests against.
  {
    name: 'inSubquery',
    parts: [lit('SELECT'), rule('identifier'), lit('FROM'), rule('identifier'), opt(lit('WHERE'), rule('expr'))],
  },
  // The subquery EXISTS takes (plan.md §27.5 S1): what it selects is never read, and its WHERE may name the outer
  // query's tables — every column there qualified. Only in a SELECT's WHERE, as a condition joined by AND.
  {
    name: 'existsSubquery',
    parts: [
      lit('SELECT'),
      choice([lit('*')], [rule('value')], [rule('qualifiedColumn')]),
      lit('FROM'),
      rule('identifier'),
      opt(lit('WHERE'), rule('expr')),
    ],
  },
  {
    name: 'compareOp',
    parts: [choice([lit('=')], [lit('<>')], [lit('!=')], [lit('<')], [lit('>')], [lit('<=')], [lit('>=')])],
  },
  // Arithmetic (plan.md §25.4 B1b): `+ -` over `* / %` over unary minus over a primary.
  {
    name: 'operand',
    parts: [rule('multiplicative'), repeat(choice([lit('+')], [lit('-')]), rule('multiplicative'))],
  },
  {
    name: 'multiplicative',
    parts: [rule('unary'), repeat(choice([lit('*')], [lit('/')], [lit('%')]), rule('unary'))],
  },
  { name: 'unary', parts: [choice([lit('-'), rule('unary')], [rule('primary')])] },
  {
    name: 'primary',
    parts: [
      choice(
        [rule('qualifiedColumn')],
        [rule('number')],
        [rule('string')],
        [lit('NULL')],
        [lit('TRUE')],
        [lit('FALSE')],
        [lit('('), rule('expr'), lit(')')],
        // Only inside HAVING — an aggregate has no group to read in a WHERE.
        [rule('aggregateCall')],
        // Only in a SELECT's WHERE, as a condition joined by AND (plan.md §27.5 S1).
        [lit('EXISTS'), lit('('), rule('existsSubquery'), lit(')')],
      ),
    ],
  },
  {
    name: 'qualifiedColumn',
    parts: [rule('identifier'), opt(lit('.'), rule('identifier'))],
  },
  // Terminals — lexical categories the tokenizer itself produces, not composed
  // of other rules. Each is its own trivial "rule" purely so a `rule()`
  // reference to it always resolves to something, the same as a real one.
  { name: 'identifier', parts: [lit('‹identifier›')] },
  { name: 'number', parts: [lit('‹number›')] },
  { name: 'string', parts: [lit('‹string›')] },
];

export function ruleNamed(name: string): GrammarRule | undefined {
  return GRAMMAR.find((r) => r.name === name);
}
