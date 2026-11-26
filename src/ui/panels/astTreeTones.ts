/**
 * Colour tones for AST tree nodes.
 *
 * The `hover:` half is plan.md §16.2 item 4's tinted rule: fill one step
 * deeper, border one step brighter, in the node's own hue rather than a shared
 * neutral.
 */
const STMT =
  'border-hue-sky/70 bg-hue-sky/10 text-hue-sky-ink hover:border-hue-sky hover:bg-hue-sky/20';
const LIST =
  'border-hue-sky/50 bg-hue-sky/5 text-hue-sky-ink hover:border-hue-sky/80 hover:bg-hue-sky/15';
const AMBER_50 =
  'border-hue-amber/50 bg-hue-amber/5 text-hue-amber-ink hover:border-hue-amber/80 hover:bg-hue-amber/15';
const AMBER_60 =
  'border-hue-amber/60 bg-hue-amber/10 text-hue-amber-ink hover:border-hue-amber/90 hover:bg-hue-amber/20';
const VIOLET_50 =
  'border-hue-violet/50 bg-hue-violet/5 text-hue-violet-ink hover:border-hue-violet/80 hover:bg-hue-violet/15';
const VIOLET_60 =
  'border-hue-violet/60 bg-hue-violet/10 text-hue-violet-ink hover:border-hue-violet/90 hover:bg-hue-violet/20';
const NEUTRAL = 'border-edge bg-surface-3 text-ink hover:border-ink-dim/50 hover:bg-surface-4';
const ORANGE_50 =
  'border-hue-orange/50 bg-hue-orange/5 text-hue-orange-ink hover:border-hue-orange/80 hover:bg-hue-orange/15';
const ORANGE_60 =
  'border-hue-orange/60 bg-hue-orange/10 text-hue-orange-ink hover:border-hue-orange/90 hover:bg-hue-orange/20';
const EMERALD_50 =
  'border-hue-emerald/50 bg-hue-emerald/5 text-hue-emerald-ink hover:border-hue-emerald/80 hover:bg-hue-emerald/15';
const EMERALD_60 =
  'border-hue-emerald/60 bg-hue-emerald/10 text-hue-emerald-ink hover:border-hue-emerald/90 hover:bg-hue-emerald/20';

export const TONES: Record<string, string> = {
  SelectStatement: STMT,
  DeleteStatement: STMT,
  InsertStatement: STMT,
  UpdateStatement: STMT,
  // A compound query (plan.md §27.5 S3) is a statement whose children are statements — the same tone.
  CompoundStatement: STMT,
  SelectList: LIST,
  ColumnList: LIST,
  Values: LIST,
  Set: LIST,
  Assignment: AMBER_50,
  From: VIOLET_60,
  Into: VIOLET_60,
  Where: AMBER_60,
  Having: AMBER_60,
  And: AMBER_50,
  Or: AMBER_50,
  Not: AMBER_50,
  IsNull: AMBER_50,
  In: AMBER_50,
  Like: AMBER_50,
  // A test on a row like the rest (plan.md §27.5 S1) — that its answer comes from another table is in its children.
  Exists: AMBER_50,
  Compare: AMBER_50,
  Column: EMERALD_50,
  Table: VIOLET_50,
  Literal: NEUTRAL,
  Star: NEUTRAL,
  Limit: ORANGE_60,
  Aggregate: ORANGE_60,
  // A scalar subquery (plan.md §27.5 S6) is a value worked out too — by a whole query, whose tree sits inside it.
  Subquery: ORANGE_60,
  Expression: ORANGE_60,
  Arith: ORANGE_50,
  OrderBy: EMERALD_60,
  GroupBy: EMERALD_60,
};
