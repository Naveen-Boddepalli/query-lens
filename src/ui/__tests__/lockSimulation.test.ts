import { describe, expect, it } from 'vitest';
import { emptyState, heldBy, release, request, waitingBy } from '../lockSimulation.ts';
import type { SimState } from '../lockSimulation.ts';

describe('request — compatibility', () => {
  it('grants a lock on an unheld resource', () => {
    const r = request(emptyState(), 'T1', 1, 'shared');
    expect(r.kind).toBe('granted');
    expect(heldBy(r.state, 'T1')).toEqual([{ resource: 1, mode: 'shared' }]);
  });

  it('grants any number of shared locks on the same resource together', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'shared').state;
    const r = request(s, 'T2', 1, 'shared');
    expect(r.kind).toBe('granted');
  });

  it('blocks an exclusive request against an existing shared holder', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'shared').state;
    const r = request(s, 'T2', 1, 'exclusive');
    expect(r.kind).toBe('blocked');
    expect(r.waitingOn).toEqual(['T1']);
  });

  it('blocks a shared request against an existing exclusive holder', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    const r = request(s, 'T2', 1, 'shared');
    expect(r.kind).toBe('blocked');
  });

  it('blocks a second exclusive request even when the first is also exclusive', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    const r = request(s, 'T2', 1, 'exclusive');
    expect(r.kind).toBe('blocked');
  });

  it('is a no-op when a transaction re-requests a lock it already holds', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'shared').state;
    const r = request(s, 'T1', 1, 'shared');
    expect(r.kind).toBe('already-held');
    expect(heldBy(r.state, 'T1')).toEqual([{ resource: 1, mode: 'shared' }]);
  });

  it('an exclusive holder re-requesting shared on the same resource is a no-op — exclusive already covers it', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    const r = request(s, 'T1', 1, 'shared');
    expect(r.kind).toBe('already-held');
  });

  it('does not block a transaction against its own lock on a different resource', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    const r = request(s, 'T1', 2, 'exclusive');
    expect(r.kind).toBe('granted');
  });
});

describe('request — never mutates its input', () => {
  it('leaves the original state untouched', () => {
    const before = emptyState();
    const snapshot = structuredClone(before);
    request(before, 'T1', 1, 'exclusive');
    expect(before).toEqual(snapshot);
  });
});

describe('release', () => {
  it('releases a held lock', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'shared').state;
    const r = release(s, 'T1', 1, 'shared');
    expect(heldBy(r.state, 'T1')).toEqual([]);
  });

  it('is a no-op when the transaction does not hold that lock', () => {
    const r = release(emptyState(), 'T1', 1, 'shared');
    expect(r.narration[0]).toMatch(/does not hold/);
  });

  it('promotes a single blocked waiter once the conflicting lock is released', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    s = request(s, 'T2', 1, 'shared').state;
    expect(waitingBy(s, 'T2')).toEqual([{ resource: 1, mode: 'shared' }]);

    const r = release(s, 'T1', 1, 'exclusive');
    expect(heldBy(r.state, 'T2')).toEqual([{ resource: 1, mode: 'shared' }]);
    expect(waitingBy(r.state, 'T2')).toEqual([]);
  });

  it('promotes every consecutive compatible shared waiter together', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    s = request(s, 'T2', 1, 'shared').state;
    s = request(s, 'T3', 1, 'shared').state;

    const r = release(s, 'T1', 1, 'exclusive');
    expect(heldBy(r.state, 'T2')).toEqual([{ resource: 1, mode: 'shared' }]);
    expect(heldBy(r.state, 'T3')).toEqual([{ resource: 1, mode: 'shared' }]);
  });

  it('stops promoting at the first exclusive waiter, and does not promote past it', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    s = request(s, 'T2', 1, 'exclusive').state; // blocked, first in queue
    s = request(s, 'T3', 1, 'shared').state; // blocked, behind T2

    const r = release(s, 'T1', 1, 'exclusive');
    expect(heldBy(r.state, 'T2')).toEqual([{ resource: 1, mode: 'exclusive' }]);
    expect(heldBy(r.state, 'T3')).toEqual([]); // still waiting — T2's exclusive grant blocks it
    expect(waitingBy(r.state, 'T3')).toEqual([{ resource: 1, mode: 'shared' }]);
  });
});

describe('deadlock detection', () => {
  it('finds the classic two-transaction cycle and aborts the younger transaction', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state; // T1 first — older
    s = request(s, 'T2', 2, 'exclusive').state; // T2 second — younger
    s = request(s, 'T1', 2, 'exclusive').state; // T1 blocks on T2

    const r = request(s, 'T2', 1, 'exclusive'); // T2 blocks on T1 — cycle
    expect(r.kind).toBe('deadlock');
    expect(r.victim).toBe('T2');
    expect(r.cycle).toEqual(['T2', 'T1', 'T2']);
  });

  it('the victim ends up holding and waiting on nothing', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    s = request(s, 'T2', 2, 'exclusive').state;
    s = request(s, 'T1', 2, 'exclusive').state;
    const r = request(s, 'T2', 1, 'exclusive');

    expect(heldBy(r.state, 'T2')).toEqual([]);
    expect(waitingBy(r.state, 'T2')).toEqual([]);
  });

  it("the survivor's blocked request is promoted once the victim's lock is freed", () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    s = request(s, 'T2', 2, 'exclusive').state;
    s = request(s, 'T1', 2, 'exclusive').state; // T1 waits on T2's page 2
    const r = request(s, 'T2', 1, 'exclusive'); // deadlock, T2 is the victim

    // T1's long-blocked request for page 2 is granted the moment T2 is aborted.
    expect(heldBy(r.state, 'T1')).toEqual(
      expect.arrayContaining([
        { resource: 1, mode: 'exclusive' },
        { resource: 2, mode: 'exclusive' },
      ]),
    );
  });

  it('does not report a deadlock for an ordinary block with no cycle', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    const r = request(s, 'T2', 1, 'shared');
    expect(r.kind).toBe('blocked');
  });

  it('does not report a deadlock when two transactions want different resources', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    s = request(s, 'T2', 2, 'exclusive').state;
    const r = request(s, 'T1', 3, 'exclusive'); // unrelated third resource, nobody holds it
    expect(r.kind).toBe('granted');
  });

  it('a transaction aborted by a deadlock makes no further requests', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    s = request(s, 'T2', 2, 'exclusive').state;
    s = request(s, 'T1', 2, 'exclusive').state;
    s = request(s, 'T2', 1, 'exclusive').state; // T2 aborted here

    const r = request(s, 'T2', 3, 'exclusive');
    expect(r.kind).toBe('transaction-aborted');
  });

  it('a three-transaction cycle is also detected', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    s = request(s, 'T2', 2, 'exclusive').state;
    s = request(s, 'T3', 3, 'exclusive').state;
    s = request(s, 'T1', 2, 'exclusive').state; // T1 waits on T2
    s = request(s, 'T2', 3, 'exclusive').state; // T2 waits on T3

    const r = request(s, 'T3', 1, 'exclusive'); // T3 waits on T1 — three-way cycle
    expect(r.kind).toBe('deadlock');
    expect(r.victim).toBe('T3'); // T3 is the youngest of the three
  });
});

describe('purity and determinism', () => {
  it('request never mutates the state it is given, even on a deadlock', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    s = request(s, 'T2', 2, 'exclusive').state;
    s = request(s, 'T1', 2, 'exclusive').state;
    const before: SimState = structuredClone(s);
    request(s, 'T2', 1, 'exclusive');
    expect(s).toEqual(before);
  });

  it('the same sequence of requests produces byte-identical states', () => {
    function run(): SimState {
      let s = emptyState();
      s = request(s, 'T1', 1, 'exclusive').state;
      s = request(s, 'T2', 2, 'exclusive').state;
      s = request(s, 'T1', 2, 'exclusive').state;
      s = request(s, 'T2', 1, 'exclusive').state;
      return s;
    }
    expect(JSON.stringify(run())).toEqual(JSON.stringify(run()));
  });

  it('every state survives structured cloning', () => {
    let s = emptyState();
    s = request(s, 'T1', 1, 'exclusive').state;
    s = request(s, 'T2', 1, 'shared').state;
    expect(structuredClone(s)).toEqual(s);
  });
});
