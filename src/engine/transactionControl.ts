/**
 * Transaction-control statements (plan.md §25.4 D1, D3). Recognised by shape, ahead of the parser: `BEGIN`, `COMMIT`
 * and `ROLLBACK` are not part of the SQL the parser reads, because they mean nothing to one statement on its own — a
 * schedule (`schedule.ts`) is what gives them a meaning. Kept in its own module so `runQuery` can refuse them with an
 * explanation without importing the schedule runner, which imports `runQuery`.
 */

export type ControlKind = 'begin' | 'commit' | 'rollback';

/** The four levels the standard names, here defined by how long a transaction holds its locks (plan.md §25.4 D3). */
export type IsolationLevel = 'read-uncommitted' | 'read-committed' | 'repeatable-read' | 'serializable';

function normalise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;+\s*$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

const BEGIN_FORMS = new Set(['BEGIN', 'BEGIN TRANSACTION', 'BEGIN WORK', 'START TRANSACTION']);
const LEVEL_CLAUSE = /^(?:BEGIN(?: TRANSACTION| WORK)?|START TRANSACTION) ISOLATION LEVEL (READ UNCOMMITTED|READ COMMITTED|REPEATABLE READ|SERIALIZABLE)$/;

/** The level a `BEGIN ISOLATION LEVEL …` asks for, or null when the statement names none. */
export function isolationLevelOf(sql: string): IsolationLevel | null {
  const match = LEVEL_CLAUSE.exec(normalise(sql));
  if (!match) return null;
  return (match[1]!.toLowerCase().replace(' ', '-')) as IsolationLevel;
}

/** `BEGIN`, `COMMIT` and `ROLLBACK`, with the optional noise words — and for `BEGIN`, an isolation level — nothing else. */
export function controlKindOf(sql: string): ControlKind | 'malformed' | null {
  const text = normalise(sql);
  if (BEGIN_FORMS.has(text) || LEVEL_CLAUSE.test(text)) return 'begin';
  if (text === 'COMMIT' || text === 'COMMIT TRANSACTION' || text === 'COMMIT WORK') return 'commit';
  if (text === 'ROLLBACK' || text === 'ROLLBACK TRANSACTION' || text === 'ROLLBACK WORK') return 'rollback';
  // Looks like transaction control but says more than this engine understands — say so, rather than let the parser
  // report an unknown statement.
  if (/^(BEGIN|START|COMMIT|ROLLBACK|END|ABORT|SAVEPOINT|RELEASE)\b/.test(text)) return 'malformed';
  return null;
}
