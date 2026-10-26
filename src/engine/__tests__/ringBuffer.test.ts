import { describe, expect, it } from 'vitest';
import { parseReferenceScans, runBufferTrace, MAX_REFERENCES } from '../bufferTrace.ts';
import { runQuery } from '../runQuery.ts';
import { createJoinCompareDatabase, createSeedDatabase } from '../seed.ts';
import { createBufferPool } from '../storage/bufferPool.ts';
import type { ScanRing } from '../storage/bufferPool.ts';
import { createTracer } from '../trace.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { EngineOptions, StepEvent } from '../types.ts';

/** plan.md §25.4 F7: a scan reads through a small ring of its own frames instead of flushing the pool. */

const HOT = [0, 1, 2, 3, 4];
const SCAN = Array.from({ length: 41 }, (_, i) => 10 + i);

function poolWith(options: Partial<EngineOptions>, pages = 100) {
  const { emit, drain } = createTracer();
  const pool = createBufferPool(
    pages,
    { ...DEFAULT_ENGINE_OPTIONS, policy: 'lru', bufferFrames: 8, ...options },
    emit,
  );
  const touch = (page: number, ring?: ScanRing, until?: number) => {
    const fetched = pool.fetch(page, ring, until);
    if (fetched) pool.unpin(fetched.frameId);
    return fetched;
  };
  const resident = () =>
    pool.state.frames.flatMap((f) => (f.pageId === null ? [] : [f.pageId])).sort((a, b) => a - b);
  // `drain` returns the whole log every time; this returns only what has happened since it was last called.
  let seen = 0;
  const since = () => {
    const all = drain();
    const fresh = all.slice(seen);
    seen = all.length;
    return fresh;
  };
  return { pool, drain, since, touch, resident };
}

const evictions = (events: readonly StepEvent[]) =>
  events.flatMap((e) => (e.stage === 'buffer' && e.action === 'evict' ? [e] : []));
const count = (events: readonly StepEvent[], action: string) =>
  events.filter((e) => e.stage === 'buffer' && e.action === action).length;

function scanThrough(ringSize: number, hot = HOT, options: Partial<EngineOptions> = {}) {
  const run = poolWith(options);
  for (const page of hot) run.touch(page);
  const ring = ringSize > 0 ? run.pool.beginScan(ringSize) : undefined;
  // The scan's extent is its own last page: what the executor's SeqScan says, so that read-ahead stays inside it.
  const until = SCAN[SCAN.length - 1]! + 1;
  for (const page of SCAN) run.touch(page, ring, until);
  if (ring) run.pool.endScan(ring);
  return run;
}

describe('a scan through a ring (the pool itself)', () => {
  it('leaves the pages already resident where they were; the same scan without a ring flushes them', () => {
    const withRing = scanThrough(3);
    expect(withRing.resident().filter((p) => HOT.includes(p))).toEqual(HOT);

    const without = scanThrough(0);
    expect(without.resident().filter((p) => HOT.includes(p))).toEqual([]);
  });

  it('holds only as many of its own pages as the ring is big', () => {
    const { resident } = scanThrough(3);
    expect(resident().filter((p) => SCAN.includes(p))).toEqual([48, 49, 50]);
  });

  it('reuses its own oldest page once the ring is full, and says so on the eviction', () => {
    const { drain } = scanThrough(3);
    const events = drain();
    const evicted = evictions(events);
    // 41 misses: the first three took the frames that were free, the other 38 recycled the scan's own.
    expect(evicted).toHaveLength(38);
    expect(evicted.every((e) => e.stage === 'buffer' && e.action === 'evict' && e.ring === true)).toBe(true);
    // Each victim is the scan's own page from three reads earlier — never one of the hot pages.
    const victims = evicted.map((e) => (e.stage === 'buffer' && e.action === 'evict' ? e.victimPageId : -1));
    expect(victims.slice(0, 3)).toEqual([10, 11, 12]);
    expect(victims.every((v) => SCAN.includes(v))).toBe(true);
    expect(evicted[0]!.label).toContain('ring of 3 frames');
  });

  it('costs a full pool no more than the ring: the first claims go the ordinary way, the policy picks them', () => {
    const all = [0, 1, 2, 3, 4, 5, 6, 7];
    const withRing = scanThrough(3, all);
    // LRU gave up its three oldest pages, 0..2, to start the ring; everything after recycled the ring.
    expect(withRing.resident().filter((p) => all.includes(p))).toEqual([3, 4, 5, 6, 7]);
    const events = withRing.drain();
    const policyChosen = evictions(events).filter((e) => !(e.stage === 'buffer' && e.action === 'evict' && e.ring));
    expect(policyChosen).toHaveLength(3);
  });

  it('does not use up the one eviction question: a ring recycles by rule, only a policy choice is asked about', () => {
    const run = poolWith({ bufferFrames: 4 });
    run.touch(0);
    run.touch(1);
    const ring = run.pool.beginScan(2);
    for (const page of [10, 11, 12, 13, 14, 15]) run.touch(page, ring);
    run.pool.endScan(ring);
    const ringEvictions = evictions(run.since());
    expect(ringEvictions.length).toBeGreaterThan(0);
    expect(ringEvictions.every((e) => e.predictable === undefined)).toBe(true);

    // The first eviction the policy itself makes is still the one that asks.
    run.touch(90);
    run.touch(91);
    run.touch(92);
    const policyEvictions = evictions(run.since());
    expect(policyEvictions[0]!.predictable).toBeDefined();
  });

  it('is an ordinary fetch once the scan has ended', () => {
    const run = poolWith({ bufferFrames: 2 });
    const ring = run.pool.beginScan(2);
    for (const page of [10, 11, 12, 13]) run.touch(page, ring);
    run.pool.endScan(ring);
    run.since();
    run.touch(14, ring);
    const [evicted] = evictions(run.since());
    expect(evicted).toBeDefined();
    expect(evicted!.stage === 'buffer' && evicted!.action === 'evict' && evicted!.ring).toBeFalsy();
  });

  it('never reuses a frame something is still holding', () => {
    const run = poolWith({ bufferFrames: 4 });
    const ring = run.pool.beginScan(2);
    run.pool.fetch(10, ring); // pinned, not released
    run.pool.fetch(11, ring); // pinned, not released
    run.pool.fetch(12, ring); // the ring's turn comes back to slot 0, whose frame is held: take a free one instead
    expect(count(run.since(), 'evict')).toBe(0);
    expect(run.resident()).toEqual([10, 11, 12]);
  });

  it('does not take back a frame that has since been given to another page', () => {
    const run = poolWith({ bufferFrames: 3 });
    const ring = run.pool.beginScan(2);
    run.touch(10, ring);
    run.touch(11, ring);
    run.touch(90); // the third frame
    run.touch(91); // full: LRU takes the oldest, which is the ring's slot-0 frame, for page 91
    run.since();
    run.touch(12, ring); // slot 0's frame now holds 91, so it is not the scan's to reuse
    const events = evictions(run.since());
    expect(events).toHaveLength(1);
    expect(events[0]!.stage === 'buffer' && events[0]!.action === 'evict' && events[0]!.ring).toBeFalsy();
    expect(run.resident()).toContain(91);
  });

  it('keeps its read-ahead inside the ring, so prefetched pages never push the hot set out either', () => {
    const hot = [0, 2, 4, 6, 8]; // not sequential, so loading them prefetches nothing
    const run = scanThrough(3, hot, { readAhead: 4 });
    const events = run.drain();
    expect(count(events, 'prefetch')).toBeGreaterThan(0);
    expect(run.resident().filter((p) => hot.includes(p))).toEqual(hot);
    // Three frames hold everything that is not hot: the page being read and what was read ahead of it, and none of it is
    // past the scan's last page, which the scan said was where its pages end.
    const others = run.resident().filter((p) => !hot.includes(p));
    expect(others).toHaveLength(3);
    expect(Math.max(...others)).toBeLessThan(SCAN[SCAN.length - 1]! + 1);
  });

  it('behaves exactly as before when no scan ever begins', () => {
    const refs = [...HOT, ...SCAN, ...HOT];
    const plain = runBufferTrace(refs, { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: 8 });
    const idle = runBufferTrace(refs, { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: 8, scanRing: 3 });
    expect(idle.events).toEqual(plain.events);
  });
});

describe('a marked scan in a reference string', () => {
  const input = '0 1 2 3 4 10-50 0 1 2 3 4';

  it('parses a range as its pages in order and as one scan', () => {
    const { refs, scans } = parseReferenceScans(input);
    expect(refs).toHaveLength(5 + 41 + 5);
    expect(refs.slice(5, 8)).toEqual([10, 11, 12]);
    expect(scans).toEqual([{ from: 5, to: 46 }]);
  });

  it('drops what is not a range of pages, and caps a long one', () => {
    const { refs, scans } = parseReferenceScans('3 9-3 -5 7- a-b 4');
    expect(refs).toEqual([3, 4]);
    expect(scans).toEqual([]);
    const long = parseReferenceScans('0-99999');
    expect(long.refs).toHaveLength(MAX_REFERENCES);
    expect(long.scans).toEqual([{ from: 0, to: MAX_REFERENCES }]);
  });

  it('saves the hot set from one scan: 46 disk reads instead of 51', () => {
    const { refs, scans } = parseReferenceScans(input);
    const options: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, policy: 'lru', bufferFrames: 8 };
    const off = runBufferTrace(refs, options, scans);
    const on = runBufferTrace(refs, { ...options, scanRing: 3 }, scans);
    expect(count(off.events, 'miss')).toBe(51);
    expect(count(on.events, 'miss')).toBe(46);
  });

  it('does not ring a scan no bigger than a quarter of the pool', () => {
    const { refs, scans } = parseReferenceScans('0 1 2 3 4 10-11 0 1 2 3 4');
    const options: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, policy: 'lru', bufferFrames: 8 };
    const off = runBufferTrace(refs, options, scans);
    const on = runBufferTrace(refs, { ...options, scanRing: 3 }, scans);
    expect(on.events).toEqual(off.events);
  });
});

describe('a SeqScan with the ring on', () => {
  const run = (sql: string, options: Partial<EngineOptions>, database = createSeedDatabase()) => {
    const result = runQuery(sql, database, { ...DEFAULT_ENGINE_OPTIONS, ...options });
    return { result, events: result.events };
  };

  it('returns the same rows and reads the same pages; only who is evicted changes', () => {
    const sql = 'SELECT * FROM users WHERE age > 30';
    const off = run(sql, {});
    const on = run(sql, { scanRing: 3 });
    expect(on.result.rows).toEqual(off.result.rows);
    expect(count(on.events, 'miss')).toBe(count(off.events, 'miss'));
    expect(count(on.events, 'miss')).toBe(12);
    // Twelve pages through a ring of three: nine recycle one of the scan's own frames.
    expect(evictions(on.events).filter((e) => e.stage === 'buffer' && e.action === 'evict' && e.ring)).toHaveLength(9);
    expect(evictions(off.events).filter((e) => e.stage === 'buffer' && e.action === 'evict' && e.ring)).toHaveLength(0);
  });

  it('is not the default: scanRing 0 and absent are the same trace', () => {
    const sql = 'SELECT * FROM users WHERE age > 30';
    expect(run(sql, { scanRing: 0 }).events).toEqual(run(sql, {}).events);
  });

  it('leaves a small table cached whole', () => {
    const sql = 'SELECT * FROM authors';
    const database = createJoinCompareDatabase();
    const on = run(sql, { scanRing: 3 }, database);
    expect(on.events.filter((e) => e.label.includes('ring of')).length).toBe(0);
    expect(on.events).toEqual(run(sql, {}, database).events);
  });

  it('keeps one ring across a nested-loop join\'s rescans, so the policy is never asked for a victim', () => {
    const database = createJoinCompareDatabase();
    // Ten outer rows, each rescanning the thirty-page `comments`: every pass recycles the same three frames.
    const sql = 'SELECT posts.title, comments.body FROM posts JOIN comments ON posts.id = comments.postId';
    const on = run(sql, { joinStrategy: 'nested-loop', policy: 'lru', bufferFrames: 8, scanRing: 3 }, database);
    const all = evictions(on.events);
    expect(all.length).toBeGreaterThan(100);
    expect(all.filter((e) => !(e.stage === 'buffer' && e.action === 'evict' && e.ring))).toHaveLength(0);
  });

  it('takes FIFO from 45 reads to 33 on a join whose outer table is a long scan, and costs LRU nothing', () => {
    const database = createJoinCompareDatabase();
    const sql = 'SELECT comments.body, posts.title FROM comments JOIN posts ON comments.postId = posts.id';
    const base = { joinStrategy: 'nested-loop' as const, bufferFrames: 8 };
    const fifoOff = run(sql, { ...base, policy: 'fifo' }, database);
    const fifoOn = run(sql, { ...base, policy: 'fifo', scanRing: 3 }, database);
    expect(fifoOn.result.rows).toEqual(fifoOff.result.rows);
    expect(count(fifoOff.events, 'miss')).toBe(45);
    expect(count(fifoOn.events, 'miss')).toBe(33);

    const lruOff = run(sql, { ...base, policy: 'lru' }, database);
    const lruOn = run(sql, { ...base, policy: 'lru', scanRing: 3 }, database);
    expect(count(lruOff.events, 'miss')).toBe(33);
    expect(count(lruOn.events, 'miss')).toBe(33);
  });
});
