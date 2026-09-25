import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPerf, createRecorder, inpBand, inpFrom, isOptedIn, mergeSamples, OPT_IN_LIFETIME_MS, parseSamples,
  readSamples, setOptIn, summarisePerf,
} from '../inp.ts';
import type { Samples } from '../inp.ts';

afterEach(() => { clearPerf(); });

const samples = (count: number, top: number[]): Samples => ({ v: 1, count, top });

describe('inpFrom — web.dev’s definition: the worst interaction, forgiving one outlier per 50', () => {
  it('is the single worst interaction below 50 interactions', () => {
    expect(inpFrom(samples(1, [180]))).toBe(180);
    expect(inpFrom(samples(49, [900, 400, 100]))).toBe(900);
  });

  it('skips the worst at 50 interactions, two worst at 100', () => {
    expect(inpFrom(samples(50, [900, 400, 100]))).toBe(400);
    expect(inpFrom(samples(99, [900, 400, 100]))).toBe(400);
    expect(inpFrom(samples(100, [900, 400, 100]))).toBe(100);
  });

  it('never runs off the end of what was kept', () => {
    expect(inpFrom(samples(10_000, [900, 400]))).toBe(400);
  });

  it('is null when nothing was measured', () => {
    expect(inpFrom(samples(0, []))).toBeNull();
    expect(inpFrom(samples(30, []))).toBeNull(); // interactions happened, none slow enough to record
  });
});

describe('inpBand', () => {
  it('uses web.dev’s thresholds', () => {
    expect(inpBand(200)).toBe('good');
    expect(inpBand(201)).toBe('needs-improvement');
    expect(inpBand(500)).toBe('needs-improvement');
    expect(inpBand(501)).toBe('poor');
  });
});

describe('mergeSamples', () => {
  it('counts every interaction but keeps only the slow ones, slowest first', () => {
    const merged = mergeSamples(null, [10, 300, 20, 120]);
    expect(merged.count).toBe(4);
    expect(merged.top).toEqual([300, 120, 20]); // 10 ms is under the 16 ms floor
  });

  it('accumulates across flushes and tabs', () => {
    const a = mergeSamples(null, [300, 200]);
    const b = mergeSamples(a, [250]);
    expect(b.count).toBe(3);
    expect(b.top).toEqual([300, 250, 200]);
  });

  it('bounds what it stores', () => {
    const many = Array.from({ length: 500 }, (_, i) => 20 + i);
    const merged = mergeSamples(null, many);
    expect(merged.count).toBe(500);
    expect(merged.top).toHaveLength(60);
    expect(merged.top[0]).toBe(519);
  });

  it('takes the true interaction total when the browser reports one', () => {
    // 3 slow ones observed out of 120 real interactions: the percentile must be over 120, not 3.
    const merged = mergeSamples(null, [400, 300, 250], 120);
    expect(merged.count).toBe(120);
    expect(inpFrom(merged)).toBe(250); // two forgiven at 120
  });
});

describe('parseSamples — storage is a stranger’s input', () => {
  it('accepts what mergeSamples writes', () => {
    expect(parseSamples(JSON.parse(JSON.stringify(mergeSamples(null, [300, 40]))))).toEqual(samples(2, [300, 40]));
  });

  it.each([null, 'x', 3, {}, { v: 2, count: 1, top: [] }, { v: 1, count: -1, top: [] }, { v: 1, count: 'a', top: [] }, { v: 1, count: 1, top: 'x' }])(
    'rejects %j', (raw) => { expect(parseSamples(raw)).toBeNull(); },
  );

  it('drops non-numeric entries and re-sorts', () => {
    expect(parseSamples({ v: 1, count: 4, top: [10, 'x', 50, null, 30] })).toEqual(samples(4, [50, 30, 10]));
  });
});

describe('createRecorder', () => {
  const memory = () => {
    let held: Samples | null = null;
    return { read: () => held, write: (s: Samples) => { held = s; }, get: () => held };
  };

  it('takes the longest event of each interaction — pointerdown, pointerup and click are one tap', () => {
    const store = memory();
    const r = createRecorder(store);
    r.observe([{ interactionId: 7, duration: 40 }, { interactionId: 7, duration: 210 }, { interactionId: 7, duration: 32 }, { interactionId: 8, duration: 64 }]);
    r.flush();
    expect(store.get()).toEqual(samples(2, [210, 64]));
  });

  it('ignores entries that are not an interaction (no id, or id 0 — a hover, a scroll frame)', () => {
    const store = memory();
    const r = createRecorder(store);
    r.observe([{ duration: 500 }, { interactionId: 0, duration: 500 }]);
    r.flush();
    expect(store.get()).toBeNull();
  });

  it('writes only what finished since the last flush', () => {
    const store = memory();
    const r = createRecorder(store);
    r.observe([{ interactionId: 1, duration: 100 }]);
    r.flush();
    r.flush(); // nothing new — must not double-count
    r.observe([{ interactionId: 2, duration: 300 }]);
    r.flush();
    expect(store.get()).toEqual(samples(2, [300, 100]));
  });

  it('counts fast interactions from performance.interactionCount, as a delta per flush', () => {
    const store = memory();
    let total = 0;
    const r = createRecorder(store, () => total);
    total = 40;
    r.observe([{ interactionId: 1, duration: 250 }]);
    r.flush();
    total = 130; // 90 more, none slow
    r.flush();
    expect(store.get()).toEqual(samples(130, [250]));
    expect(inpFrom(store.get()!)).toBe(250); // 130 interactions forgive two — but only one was recorded
  });
});

describe('opt-in and storage', () => {
  it('is off by default, on until a deadline, then lapses on its own', () => {
    expect(isOptedIn()).toBe(false);
    setOptIn(true, 1_000);
    expect(isOptedIn(1_001)).toBe(true);
    expect(isOptedIn(1_000 + OPT_IN_LIFETIME_MS - 1)).toBe(true);
    expect(isOptedIn(1_000 + OPT_IN_LIFETIME_MS)).toBe(false);
  });

  it('clearPerf forgets the flag and the samples', () => {
    setOptIn(true);
    localStorage.setItem('querylens:perf', JSON.stringify(samples(3, [100])));
    expect(readSamples()).not.toBeNull();
    clearPerf();
    expect(isOptedIn()).toBe(false);
    expect(readSamples()).toBeNull();
  });

  it('a corrupt stored value reads as "nothing measured", not a crash', () => {
    localStorage.setItem('querylens:perf', '{not json');
    expect(readSamples()).toBeNull();
  });

  it('summarisePerf reads storage and adds coarse device context', () => {
    localStorage.setItem('querylens:perf', JSON.stringify(samples(60, [480, 300, 90])));
    const s = summarisePerf();
    expect(s.inp).toBe(300); // one forgiven at 60
    expect(s.interactions).toBe(60);
    expect(s.cores).toBeGreaterThanOrEqual(0);
    expect(typeof s.viewportPx).toBe('number');
    expect(typeof s.touch).toBe('boolean');
    // and nothing that identifies the person
    expect(Object.keys(s).sort()).toEqual(['cores', 'inp', 'interactions', 'touch', 'viewportPx']);
  });

  it('summarisePerf with nothing stored reports no INP', () => {
    expect(summarisePerf().inp).toBeNull();
    expect(summarisePerf().interactions).toBe(0);
  });
});
