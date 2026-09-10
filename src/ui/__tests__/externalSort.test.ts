import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { planExternalSort, shuffledRange, SORT_LIMITS } from '../externalSort.ts';

describe('shuffledRange', () => {
  it('is a permutation of 1..n', () => {
    const out = shuffledRange(20, 42);
    expect([...out].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('is deterministic for a seed and varies across seeds', () => {
    expect(shuffledRange(16, 7)).toEqual(shuffledRange(16, 7));
    expect(shuffledRange(16, 7)).not.toEqual(shuffledRange(16, 8));
  });
});

describe('planExternalSort', () => {
  const base = shuffledRange(32, 1);

  it('produces one fully-sorted run that is a permutation of the input', () => {
    const plan = planExternalSort(base, { pageSize: 2, memPages: 3 });
    const last = plan.passes.at(-1)!;
    expect(last.runs).toHaveLength(1);
    const out = last.runs[0]!.values;
    expect(out).toEqual([...base].sort((a, b) => a - b));
  });

  it('pass 0 is run generation, each run sorted and no larger than memPages worth of pages', () => {
    const plan = planExternalSort(base, { pageSize: 3, memPages: 4 });
    const gen = plan.passes[0]!;
    expect(gen.kind).toBe('generate');
    expect(gen.merges).toEqual([]);
    expect(plan.initialRunCount).toBe(gen.runs.length);
    for (const run of gen.runs) {
      expect(run.values).toEqual([...run.values].sort((a, b) => a - b));
      expect(run.values.length).toBeLessThanOrEqual(plan.memPages * plan.pageSize);
    }
  });

  it('every merge pass fans in at most memPages-1 runs and each output is sorted', () => {
    const plan = planExternalSort(base, { pageSize: 2, memPages: 3 });
    for (const pass of plan.passes.slice(1)) {
      expect(pass.kind).toBe('merge');
      for (const merge of pass.merges) {
        expect(merge.sourceIds.length).toBeLessThanOrEqual(plan.fanIn);
        const out = pass.runs.find((r) => r.id === merge.outputId)!;
        expect(out.values).toEqual([...out.values].sort((a, b) => a - b));
        // Provenance lines up element-for-element with the output run.
        expect(merge.origin).toHaveLength(out.values.length);
      }
    }
  });

  it('I/O is 2 * pageCount per pass, over 1 + mergePassCount passes', () => {
    const plan = planExternalSort(base, { pageSize: 2, memPages: 3 });
    expect(plan.pageCount).toBe(16);
    expect(plan.ioPerPass).toBe(32);
    expect(plan.mergePassCount).toBe(plan.passes.length - 1);
    expect(plan.totalIO).toBe(plan.ioPerPass * (1 + plan.mergePassCount));
  });

  it('more memory means fewer merge passes and less total I/O', () => {
    const tight = planExternalSort(base, { pageSize: 2, memPages: 3 });
    const roomy = planExternalSort(base, { pageSize: 2, memPages: 6 });
    expect(roomy.mergePassCount).toBeLessThan(tight.mergePassCount);
    expect(roomy.totalIO).toBeLessThan(tight.totalIO);
  });

  it('an input that fits in memory needs no merge pass', () => {
    const plan = planExternalSort(shuffledRange(6, 2), { pageSize: 3, memPages: 4 });
    expect(plan.fitsInMemory).toBe(true);
    expect(plan.mergePassCount).toBe(0);
    expect(plan.passes).toHaveLength(1);
    expect(plan.totalIO).toBe(plan.ioPerPass);
  });

  it('clamps memPages to at least 3 so the fan-in makes progress', () => {
    const plan = planExternalSort(base, { pageSize: 2, memPages: 2 });
    expect(plan.memPages).toBe(3);
    expect(plan.fanIn).toBe(2);
  });

  it('always converges to a sorted permutation, for any legal parameters', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: SORT_LIMITS.minRecords, max: SORT_LIMITS.maxRecords }),
        fc.integer({ min: 0, max: 9999 }),
        fc.integer({ min: SORT_LIMITS.minPageSize, max: SORT_LIMITS.maxPageSize }),
        fc.integer({ min: SORT_LIMITS.minMemPages, max: SORT_LIMITS.maxMemPages }),
        (n, seed, pageSize, memPages) => {
          const input = shuffledRange(n, seed);
          const plan = planExternalSort(input, { pageSize, memPages });
          const last = plan.passes.at(-1)!;
          expect(last.runs).toHaveLength(1);
          expect(last.runs[0]!.values).toEqual([...input].sort((a, b) => a - b));
        },
      ),
    );
  });
});
