import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  createTraceProjector,
  initialViewState,
  stateAt,
} from '../viewState.ts';
import { DEFAULT_ENGINE_OPTIONS } from '../types.ts';
import type { EngineOptions, StepEvent, StepEventBody } from '../types.ts';

const opts: EngineOptions = { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: 3 };

// Omit<> over a discriminated union collapses to the common keys, which is
// why the body type is exported separately.
function ev(id: number, body: StepEventBody): StepEvent {
  return { ...body, id, label: `step ${id}` };
}

/** A trace touching every stage, so the projector is exercised end to end. */
function sampleEvents(): StepEvent[] {
  const bodies: StepEventBody[] = [
    { stage: 'parse', ast: { id: 'r', kind: 'SelectStatement', label: 'SELECT' } },
    { stage: 'plan', planTree: { op: 'SeqScan', label: 'SeqScan users' } },
    {
      stage: 'optimize',
      rule: 'predicate-pushdown',
      before: { op: 'Filter', label: 'Filter' },
      after: { op: 'IndexScan', label: 'IndexScan' },
    },
    { stage: 'lock', action: 'acquire', pageId: 0, mode: 'shared' },
    { stage: 'buffer', action: 'miss', pageId: 0, frameId: 0 },
    { stage: 'buffer', action: 'load', pageId: 0, frameId: 0 },
    { stage: 'index', action: 'traverse', nodeId: 'n0', key: 5 },
    { stage: 'buffer', action: 'miss', pageId: 3, frameId: 1 },
    { stage: 'buffer', action: 'load', pageId: 3, frameId: 1 },
    { stage: 'buffer', action: 'hit', pageId: 3, frameId: 1 },
    { stage: 'index', action: 'found', nodeId: 'n3', key: 5 },
    { stage: 'execute', op: 'IndexScan', rowsProduced: 1 },
    { stage: 'lock', action: 'release', pageId: 0, mode: 'shared' },
    { stage: 'result', rows: [{ id: 5, name: 'ada' }] },
  ];
  return bodies.map((body, i) => ev(i, body));
}

describe('initialViewState', () => {
  it('creates one empty frame per configured buffer frame', () => {
    const s = initialViewState(opts);
    expect(s.frames).toHaveLength(3);
    expect(s.frames.every((f) => f.pageId === null && f.usageCount === 0)).toBe(true);
    expect(s.step).toBe(0);
  });
});

describe('applyEvent', () => {
  it('does not mutate the state it is given', () => {
    const before = initialViewState(opts);
    const snapshot = structuredClone(before);
    applyEvent(before, ev(0, { stage: 'buffer', action: 'load', pageId: 4, frameId: 1 }));
    expect(before).toEqual(snapshot);
  });

  it('loads a page into the named frame', () => {
    const s = applyEvent(
      initialViewState(opts),
      ev(0, { stage: 'buffer', action: 'load', pageId: 4, frameId: 1 }),
    );
    expect(s.frames[1]).toMatchObject({ pageId: 4, usageCount: 1, lastTouchedAt: 0 });
    expect(s.frames[0]?.pageId).toBeNull();
  });

  it('counts hits and caps usageCount at 5', () => {
    let s = applyEvent(
      initialViewState(opts),
      ev(0, { stage: 'buffer', action: 'load', pageId: 4, frameId: 0 }),
    );
    for (let i = 1; i <= 10; i++) {
      s = applyEvent(s, ev(i, { stage: 'buffer', action: 'hit', pageId: 4, frameId: 0 }));
    }
    expect(s.frames[0]?.usageCount).toBe(5);
    expect(s.bufferStats.hits).toBe(10);
  });

  it('empties the frame on evict and counts the eviction', () => {
    let s = applyEvent(
      initialViewState(opts),
      ev(0, { stage: 'buffer', action: 'load', pageId: 4, frameId: 2 }),
    );
    s = applyEvent(
      s,
      ev(1, { stage: 'buffer', action: 'evict', frameId: 2, victimPageId: 4, pageId: 9 }),
    );
    expect(s.frames[2]).toMatchObject({ pageId: null, usageCount: 0 });
    expect(s.bufferStats.evictions).toBe(1);
  });

  it('a sweep decrements one frame and moves the clock hand', () => {
    let s = applyEvent(
      initialViewState(opts),
      ev(0, { stage: 'buffer', action: 'load', pageId: 4, frameId: 0 }),
    );
    s = applyEvent(
      s,
      ev(1, { stage: 'buffer', action: 'sweep', frameId: 0, usageCountAfter: 0, clockHand: 1 }),
    );
    expect(s.frames[0]?.usageCount).toBe(0);
    expect(s.frames[0]?.pageId).toBe(4); // sweeping does not evict
    expect(s.clockHand).toBe(1);
  });

  it('releases only the matching lock', () => {
    let s = applyEvent(
      initialViewState(opts),
      ev(0, { stage: 'lock', action: 'acquire', pageId: 1, mode: 'shared' }),
    );
    s = applyEvent(s, ev(1, { stage: 'lock', action: 'acquire', pageId: 2, mode: 'exclusive' }));
    s = applyEvent(s, ev(2, { stage: 'lock', action: 'release', pageId: 1, mode: 'shared' }));
    expect(s.locks).toEqual([{ pageId: 2, mode: 'exclusive' }]);
  });

  it('records operator row counts, updating rather than duplicating', () => {
    let s = applyEvent(
      initialViewState(opts),
      ev(0, { stage: 'execute', op: 'SeqScan', rowsProduced: 1 }),
    );
    s = applyEvent(s, ev(1, { stage: 'execute', op: 'SeqScan', rowsProduced: 2 }));
    s = applyEvent(s, ev(2, { stage: 'execute', op: 'Filter', rowsProduced: 1 }));
    expect(s.operators).toEqual([
      { op: 'SeqScan', rowsProduced: 2 },
      { op: 'Filter', rowsProduced: 1 },
    ]);
  });

  it('keeps the pre-optimisation plan so the rewrite can be shown side by side', () => {
    const before = { op: 'Filter', label: 'Filter' };
    const after = { op: 'IndexScan', label: 'IndexScan' };
    const s = applyEvent(
      initialViewState(opts),
      ev(0, { stage: 'optimize', rule: 'predicate-pushdown', before, after }),
    );
    expect(s.planBefore).toEqual(before);
    expect(s.plan).toEqual(after);
    expect(s.appliedRules).toEqual(['predicate-pushdown']);
  });
});

describe('createTraceProjector', () => {
  const events = sampleEvents();

  it('at(0) is the initial state and at(length) has consumed everything', () => {
    const p = createTraceProjector(events, opts);
    expect(p.at(0)).toEqual(initialViewState(opts));
    expect(p.at(events.length).step).toBe(events.length);
  });

  it('clamps out-of-range steps instead of throwing', () => {
    const p = createTraceProjector(events, opts);
    expect(p.at(-5).step).toBe(0);
    expect(p.at(events.length + 100).step).toBe(events.length);
  });

  it('stepping back returns exactly the state stepping forward produced', () => {
    const p = createTraceProjector(events, opts);
    const forward = events.map((_, i) => structuredClone(p.at(i + 1)));
    for (let i = events.length - 1; i >= 0; i--) {
      expect(p.at(i + 1)).toEqual(forward[i]);
    }
  });

  it('agrees with a naive fold at every step', () => {
    const p = createTraceProjector(events, opts);
    for (let n = 0; n <= events.length; n++) {
      const naive = events.slice(0, n).reduce(applyEvent, initialViewState(opts));
      expect(p.at(n)).toEqual(naive);
    }
  });

  it('returns the identical object for a repeated read (memoised)', () => {
    const p = createTraceProjector(events, opts);
    expect(p.at(4)).toBe(p.at(4));
  });
});

describe('stateAt', () => {
  it('projects a full trace to its final result', () => {
    const events = sampleEvents();
    const final = stateAt(events, events.length, opts);
    expect(final.rows).toEqual([{ id: 5, name: 'ada' }]);
    expect(final.stage).toBe('result');
    expect(final.indexOutcome).toBe('found');
    expect(final.bufferStats).toEqual({ hits: 1, misses: 2, evictions: 0 });
    expect(final.locks).toEqual([]);
  });
});

describe('placeholder trace consistency', () => {
  it('never reports a hit on a page that was not loaded into that frame', () => {
    const events = sampleEvents();
    const resident = new Map<number, number>(); // frameId -> pageId
    for (const e of events) {
      if (e.stage !== 'buffer') continue;
      if (e.action === 'load') resident.set(e.frameId, e.pageId);
      if (e.action === 'evict') resident.delete(e.frameId);
      if (e.action === 'hit') {
        expect(resident.get(e.frameId)).toBe(e.pageId);
      }
    }
  });

  it('reaches every pipeline stage, so the shell has something to show for each', () => {
    const events = sampleEvents();
    const stages = new Set(events.map((e) => e.stage));
    for (const s of ['parse', 'plan', 'optimize', 'execute', 'buffer', 'index', 'lock', 'result']) {
      expect(stages).toContain(s);
    }
  });
});
