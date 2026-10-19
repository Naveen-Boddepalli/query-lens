/** The parallel-execution challenge (plan.md §27.5 P1), run by the engine's own morsel model, as the tool runs it. */

import type { JoinExchange } from '../../../engine/exchange.ts';
import { DATASETS } from '../../../engine/datasets.ts';
import { scaling } from '../../../engine/parallel.ts';
import { joinHref, joinRun } from '../../../ui/exchangePresets.ts';
import { isDispatch, parallelHref, parallelRun } from '../../../ui/parallelPresets.ts';
import { fixed, num, str } from './shared.ts';
import type { Checkers } from './shared.ts';

/** Four workers, the last three times slower, on the totals by status. */
export const SLOW_FOURTH = [1, 1, 1, 3] as const;
export const TARGET_SPEEDUP = 3;

export const CHECKERS: Checkers = {
  'outrun-the-slow-worker': (v) => {
    const raw = str(v, 'dispatch');
    const dispatch = isDispatch(raw) ? raw : 'static';
    const morselPages = num(v, 'morsel');
    const r = parallelRun('grouped', 4, dispatch, morselPages, SLOW_FOURTH);
    return {
      passed: r.speedup >= TARGET_SPEEDUP,
      facts: [
        { label: 'speedup', value: `${fixed(r.speedup)}×` },
        { label: 'ticks', value: r.ticks.toLocaleString('en-US') },
        { label: 'one worker alone', value: r.serialTicks.toLocaleString('en-US') },
        { label: 'morsels stolen', value: String(r.steals) },
        { label: 'pages read remotely', value: String(r.runs.reduce((s, x) => s + x.remotePages, 0)) },
      ],
      toolHref: parallelHref('grouped', 4, dispatch, morselPages, SLOW_FOURTH),
    };
  },
  // plan.md §27.5 P2: three joins on eight workers, and the exchange that runs each sooner.
  'meet-the-rows': (v) => {
    const joins = [
      ['small-big', 'smallBig', 'small with big'],
      ['big-big', 'bigBig', 'big with big'],
      ['few-keys', 'fiveKeys', 'five keys'],
    ] as const;
    const verdicts = joins.map(([id, key, words]) => {
      const chosen: JoinExchange = str(v, key) === 'broadcast' ? 'broadcast' : 'repartition';
      const mine = joinRun(id, JOIN_WORKERS, chosen);
      const other = joinRun(id, JOIN_WORKERS, chosen === 'broadcast' ? 'repartition' : 'broadcast');
      return { id, words, chosen, mine, right: mine.ticks <= other.ticks };
    });
    const wrong = verdicts.find((x) => !x.right);
    return {
      passed: wrong === undefined,
      facts: verdicts.map((x) => ({
        label: x.words,
        value: `${x.chosen}: ${fixed(x.mine.speedup)}×, ${x.mine.moved.total.toLocaleString('en-US')} rows moved${x.right ? '' : ' — the other way is faster'}`,
      })),
      toolHref: joinHref(wrong?.id ?? 'big-big', JOIN_WORKERS, wrong?.chosen ?? 'repartition'),
    };
  },
};

/** The join challenge's workers. */
export const JOIN_WORKERS = 8;

/** The efficiency challenge's bar (plan.md §27.5 P3): each worker worth at least four fifths of one. */
export const EFFICIENCY_FLOOR = 0.8;

const BY_ACCOUNT = 'SELECT account, COUNT(*), SUM(amount) FROM transactions GROUP BY account';

CHECKERS['efficiency-floor'] = (v) => {
  const workers = num(v, 'workers');
  const s = scaling(BY_ACCOUNT, DATASETS.transactions.make(), { dispatch: 'stealing', morselPages: 16, rowsPerPage: 4 }, 8);
  if ('ok' in s) throw new Error(s.error);
  const at = s.points[workers - 1]!;
  const next = s.points[workers];
  const passed = at.efficiency >= EFFICIENCY_FLOOR && (next === undefined || next.efficiency < EFFICIENCY_FLOOR);
  return {
    passed,
    facts: [
      { label: `${String(workers)} workers`, value: `${fixed(at.speedup)}×, ${(at.efficiency * 100).toFixed(0)}% efficient` },
      ...(next ? [{ label: `${String(workers + 1)} workers`, value: `${fixed(next.speedup)}×, ${(next.efficiency * 100).toFixed(0)}% efficient` }] : []),
      { label: 'Karp–Flatt serial fraction', value: at.karpFlatt === null ? '—' : fixed(at.karpFlatt, 3) },
    ],
    toolHref: '/compare?mode=parallel&q=account',
  };
};
