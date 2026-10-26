// @vitest-environment node
/**
 * Differential testing against SQLite (plan.md §25.4 A1b). The same generated
 * statement is run by QueryLens and by SQLite; the answers must agree.
 *
 * What this can and cannot say: it says QueryLens returns what SQLite returns
 * *on the constructs the two share with the same meaning*. It says nothing
 * about the cases the two define differently — those are in `ledger.ts`, each
 * one pinned by its own test, so a difference is never silently skipped.
 */

import fc from 'fast-check';
import { describe, it, vi } from 'vitest';
import { ORACLE_TIMEOUT, oracleParams } from './config.ts';
import { optionsArb, sessionArb } from './generate.ts';
import { runSession } from './harness.ts';

vi.setConfig({ testTimeout: ORACLE_TIMEOUT });

describe('differential — QueryLens vs SQLite', () => {
  it('SELECT: projection, WHERE, ORDER BY, LIMIT', () => {
    fc.assert(
      fc.property(sessionArb('select'), optionsArb, ({ tables, steps }, options) => {
        runSession(tables, steps, options);
      }),
      oracleParams(),
    );
  });

  it('aggregates and GROUP BY', () => {
    fc.assert(
      fc.property(sessionArb('aggregate'), optionsArb, ({ tables, steps }, options) => {
        runSession(tables, steps, options);
      }),
      oracleParams(),
    );
  });

  it('JOIN', () => {
    fc.assert(
      fc.property(sessionArb('join'), optionsArb, ({ tables, steps }, options) => {
        runSession(tables, steps, options);
      }),
      oracleParams(),
    );
  });

  it('GROUP BY, aggregates, HAVING and ORDER BY over a JOIN (plan.md §26 Feature 1, slice c)', () => {
    fc.assert(
      fc.property(sessionArb('join-aggregate'), optionsArb, ({ tables, steps }, options) => {
        runSession(tables, steps, options);
      }),
      oracleParams(),
    );
  });

  it('INSERT / UPDATE / DELETE, then a read of what they left behind', () => {
    fc.assert(
      fc.property(sessionArb('any'), optionsArb, ({ tables, steps }, options) => {
        runSession(tables, steps, options);
      }),
      oracleParams(),
    );
  });
});
