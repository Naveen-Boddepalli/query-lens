import { describe, expect, it } from 'vitest';
import type { PredictionPrompt } from '../../engine/index.ts';
import { stepAnnouncement } from '../stepAnnouncement.ts';

const PROMPT: PredictionPrompt = {
  question: 'What happens when page 8 is requested?',
  options: [
    { id: 'hit', label: 'A buffer hit' },
    { id: 'evict', label: 'A miss, evicting page 1' },
  ],
  correctOptionId: 'evict',
  explanation: 'The pool is full, so the least-recently-used page is dropped.',
};

describe('stepAnnouncement', () => {
  it('is just the narration on an ordinary step', () => {
    expect(stepAnnouncement({ narration: 'Read page 8 from disk into frame 0.' })).toBe(
      'Read page 8 from disk into frame 0.',
    );
  });

  it('falls back to a prompt to begin when there is no narration yet', () => {
    expect(stepAnnouncement({ narration: '' })).toMatch(/step forward/i);
  });

  it('reads out an unanswered prediction with its options', () => {
    const out = stepAnnouncement({
      narration: '',
      prediction: { prompt: PROMPT, answer: undefined },
    });
    expect(out).toContain('Predict before revealing.');
    expect(out).toContain(PROMPT.question);
    expect(out).toContain('2 options:');
    expect(out).toContain('A buffer hit');
    expect(out).toContain('A miss, evicting page 1');
  });

  it('confirms a correct answer and points at the next key', () => {
    const out = stepAnnouncement({
      narration: '',
      prediction: { prompt: PROMPT, answer: 'evict' },
    });
    expect(out.startsWith('Correct.')).toBe(true);
    expect(out).toContain(PROMPT.explanation);
    expect(out).toMatch(/right arrow/i);
  });

  it('marks a wrong answer without hiding the explanation', () => {
    const out = stepAnnouncement({
      narration: '',
      prediction: { prompt: PROMPT, answer: 'hit' },
    });
    expect(out.startsWith('Not quite.')).toBe(true);
    expect(out).toContain(PROMPT.explanation);
  });

  it('handles a skipped prediction', () => {
    const out = stepAnnouncement({
      narration: '',
      prediction: { prompt: PROMPT, answer: '' },
    });
    expect(out).toContain('skipped');
    expect(out).not.toContain('Not quite');
  });

  it('says so when the query did not run', () => {
    expect(stepAnnouncement({ narration: '', error: true })).toMatch(/did.?n.?t run/i);
  });
});
