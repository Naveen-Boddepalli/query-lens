import { afterEach, describe, expect, it } from 'vitest';
import { clearProgress, readProgress, recordPrediction, recordStages } from '../progress.ts';

afterEach(() => { clearProgress(); });

describe('progress', () => {
  it('starts empty', () => {
    expect(readProgress()).toEqual({ stages: [], asked: 0, right: 0 });
  });

  it('unions seen stages and does not duplicate', () => {
    recordStages(['parse', 'plan']);
    recordStages(['plan', 'execute']);
    expect(new Set(readProgress().stages)).toEqual(new Set(['parse', 'plan', 'execute']));
  });

  it('counts predictions and how many were right', () => {
    recordPrediction(true);
    recordPrediction(false);
    recordPrediction(true);
    const p = readProgress();
    expect(p.asked).toBe(3);
    expect(p.right).toBe(2);
  });

  it('clears', () => {
    recordStages(['parse']);
    recordPrediction(true);
    clearProgress();
    expect(readProgress()).toEqual({ stages: [], asked: 0, right: 0 });
  });

  it('survives a corrupt value', () => {
    localStorage.setItem('querylens:progress', '{ not json');
    expect(readProgress()).toEqual({ stages: [], asked: 0, right: 0 });
    localStorage.setItem('querylens:progress', JSON.stringify({ stages: 'nope', asked: -1, right: 2.7 }));
    expect(readProgress()).toEqual({ stages: [], asked: 0, right: 2 });
  });
});
