import { describe, expect, it } from 'vitest';
import { emptyTable, heldBy, release, releaseAll, request } from '../locks/lockTable.ts';

const label = (resource: string) => `row ${resource}`;

describe('the engine lock table (plan.md §25.4 D2)', () => {
  it('promotes a waiter that is upgrading its own shared lock once the other readers let go', () => {
    let state = emptyTable();
    state = request(state, 'T1', 'r', 'shared', label).state;
    state = request(state, 'T2', 'r', 'shared', label).state;
    const upgrade = request(state, 'T1', 'r', 'exclusive', label);
    expect(upgrade.kind).toBe('blocked');
    expect(upgrade.waitingOn).toEqual(['T2']);

    const freed = release(upgrade.state, 'T2', 'r', 'shared', label);
    expect(freed.promoted).toEqual(['T1']);
    // The exclusive lock replaces the shared one; it does not sit beside it.
    expect(heldBy(freed.state, 'T1')).toEqual([{ resource: 'r', mode: 'exclusive' }]);
  });

  it('says the words the caller gave for a resource', () => {
    const outcome = request(emptyTable(), 'T1', '7', 'exclusive', (r) => `the vault ${r}`);
    expect(outcome.narration).toEqual(['T1 is granted an exclusive lock on the vault 7.']);
  });

  it('releaseAll ends a transaction: its locks go, its waits go, and the next waiter in line is promoted', () => {
    let state = emptyTable();
    state = request(state, 'T1', 'r', 'exclusive', label).state;
    state = request(state, 'T2', 'r', 'shared', label).state;
    state = request(state, 'T3', 'r', 'shared', label).state;
    const ended = releaseAll(state, 'T1', label);
    expect(ended.promoted).toEqual(['T2', 'T3']);
    expect(ended.state.aborted).toEqual([]);
  });

  it('records an abort only when asked to', () => {
    const state = request(emptyTable(), 'T1', 'r', 'shared', label).state;
    expect(releaseAll(state, 'T1', label, true).state.aborted).toEqual(['T1']);
  });
});
