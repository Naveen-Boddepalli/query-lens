import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearCompleted, readCompleted, setCompleted } from '../learnProgress.ts';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('learnProgress', () => {
  it('starts empty and round-trips a set of ids', () => {
    expect(readCompleted().size).toBe(0);

    setCompleted('first-query', true);
    setCompleted('eviction', true);
    expect([...readCompleted()].sort()).toEqual(['eviction', 'first-query']);

    setCompleted('first-query', false);
    expect([...readCompleted()]).toEqual(['eviction']);

    clearCompleted();
    expect(readCompleted().size).toBe(0);
  });

  it('ignores a corrupt or non-array value rather than throwing', () => {
    localStorage.setItem('querylens:learn', '{"not":"an array"}');
    expect(readCompleted().size).toBe(0);
    localStorage.setItem('querylens:learn', 'not json at all');
    expect(readCompleted().size).toBe(0);
  });

  it('drops non-string entries', () => {
    localStorage.setItem('querylens:learn', JSON.stringify(['ok', 3, null, 'fine']));
    expect([...readCompleted()].sort()).toEqual(['fine', 'ok']);
  });

  it('degrades to empty when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readCompleted().size).toBe(0);
    // and writing does not throw either
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => setCompleted('x', true)).not.toThrow();
  });
});
