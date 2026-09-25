/**
 * How hard the oracle looks. CI runs a **seeded, bounded** count so a red build
 * is always reproducible and the job stays short (plan.md §25.5 rule 7); the
 * scheduled workflow (`.github/workflows/oracle.yml`) turns the same suites up
 * with a fresh seed each run and prints the seed it used.
 *
 * 1,000 is not arbitrary: injected bugs in rare query shapes (a rewrite that drops a `DISTINCT` under a
 * `WHERE`) survived 200 and 400 cases and die at 800, at about two seconds of CI time.
 *
 *   ORACLE_RUNS  cases per property   (default 1000)
 *   ORACLE_SEED  fast-check seed      (default: a fixed number)
 */

const int = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};

export const ORACLE_SEED = int('ORACLE_SEED', 20260925);
export const ORACLE_RUNS = int('ORACLE_RUNS', 1000);

/** Parameters for `fc.assert`. On failure `fast-check` prints the shrunk counterexample and the `seed`/`path` that replays it. */
export const oracleParams = (scale = 1): { seed: number; numRuns: number } => ({
  seed: ORACLE_SEED,
  numRuns: Math.max(1, Math.round(ORACLE_RUNS * scale)),
});

/** A long run (`ORACLE_RUNS=20000`) takes far longer than vitest's 5 s default per test. */
export const ORACLE_TIMEOUT = 20 * 60_000;
