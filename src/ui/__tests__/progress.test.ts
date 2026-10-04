import { afterEach, describe, expect, it } from 'vitest';
import { clearProgress, readProgress, recordPrediction, recordStages } from '../progress.ts';

afterEach(() => { clearProgress(); });

const NO_CONFIDENCE = {
  guessing: { asked: 0, right: 0 },
  'fairly-sure': { asked: 0, right: 0 },
  certain: { asked: 0, right: 0 },
};

describe('progress', () => {
  it('starts empty', () => {
    expect(readProgress()).toEqual({ stages: [], asked: 0, right: 0, byConfidence: NO_CONFIDENCE });
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

  it('splits the tally by the confidence rated before the commit', () => {
    recordPrediction(false, 'certain');
    recordPrediction(true, 'certain');
    recordPrediction(true, 'guessing');
    const p = readProgress();
    expect(p.byConfidence.certain).toEqual({ asked: 2, right: 1 });
    expect(p.byConfidence.guessing).toEqual({ asked: 1, right: 1 });
    expect(p.byConfidence['fairly-sure']).toEqual({ asked: 0, right: 0 });
  });

  it('counts an unrated prediction in the totals but not in any confidence level', () => {
    recordPrediction(true);
    const p = readProgress();
    expect(p.asked).toBe(1);
    expect(p.byConfidence).toEqual(NO_CONFIDENCE);
  });

  it('clears', () => {
    recordStages(['parse']);
    recordPrediction(true, 'certain');
    clearProgress();
    expect(readProgress()).toEqual({ stages: [], asked: 0, right: 0, byConfidence: NO_CONFIDENCE });
  });

  it('survives a corrupt value', () => {
    localStorage.setItem('querylens:progress', '{ not json');
    expect(readProgress()).toEqual({ stages: [], asked: 0, right: 0, byConfidence: NO_CONFIDENCE });
    localStorage.setItem('querylens:progress', JSON.stringify({ stages: 'nope', asked: -1, right: 2.7 }));
    expect(readProgress()).toEqual({ stages: [], asked: 0, right: 2, byConfidence: NO_CONFIDENCE });
  });

  it('reads a record written before confidence existed as having no rated predictions', () => {
    localStorage.setItem('querylens:progress', JSON.stringify({ stages: ['parse'], asked: 4, right: 3 }));
    const p = readProgress();
    expect(p).toMatchObject({ asked: 4, right: 3 });
    expect(p.byConfidence).toEqual(NO_CONFIDENCE);
  });

  it('ignores a malformed confidence tally rather than trusting it', () => {
    localStorage.setItem(
      'querylens:progress',
      JSON.stringify({ asked: 2, right: 1, byConfidence: { certain: { asked: 'two', right: -4 }, guessing: null } }),
    );
    expect(readProgress().byConfidence).toEqual(NO_CONFIDENCE);
  });
});
