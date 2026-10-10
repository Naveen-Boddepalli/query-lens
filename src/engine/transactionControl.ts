/**
 * Transaction-control statements (plan.md §25.4 D1). Recognised by shape, ahead of the parser: `BEGIN`, `COMMIT` and
 * `ROLLBACK` are not part of the SQL the parser reads, because they mean nothing to one statement on its own — a
 * schedule (`schedule.ts`) is what gives them a meaning. Kept in its own module so `runQuery` can refuse them with an
 * explanation without importing the schedule runner, which imports `runQuery`.
 */

export type ControlKind = 'begin' | 'commit' | 'rollback';

/** `BEGIN`, `COMMIT` and `ROLLBACK`, with the optional noise words, and nothing after them. */
export function controlKindOf(sql: string): ControlKind | 'malformed' | null {
  const text = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;+\s*$/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
  if (text === 'BEGIN' || text === 'BEGIN TRANSACTION' || text === 'BEGIN WORK' || text === 'START TRANSACTION') {
    return 'begin';
  }
  if (text === 'COMMIT' || text === 'COMMIT TRANSACTION' || text === 'COMMIT WORK') return 'commit';
  if (text === 'ROLLBACK' || text === 'ROLLBACK TRANSACTION' || text === 'ROLLBACK WORK') return 'rollback';
  // Looks like transaction control but says more than this engine understands — say so, rather than let the parser
  // report an unknown statement.
  if (/^(BEGIN|START|COMMIT|ROLLBACK|END|ABORT|SAVEPOINT|RELEASE)\b/.test(text)) return 'malformed';
  return null;
}
