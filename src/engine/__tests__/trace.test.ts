import { describe, expect, it } from 'vitest';
import { createTracer } from '../trace.ts';

describe('createTracer', () => {
  it('assigns ids equal to the array index', () => {
    const { emit, drain } = createTracer();
    emit('a', { stage: 'execute', op: 'SeqScan', rowsProduced: 0 });
    emit('b', { stage: 'execute', op: 'Filter', rowsProduced: 1 });
    emit('c', { stage: 'result', rows: [] });

    const events = drain();
    expect(events.map((e) => e.id)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.label)).toEqual(['a', 'b', 'c']);
  });

  it('omits `predictable` entirely when no prompt is given', () => {
    const { emit, drain } = createTracer();
    emit('no prompt', { stage: 'result', rows: [] });
    expect('predictable' in drain()[0]!).toBe(false);
  });

  it('attaches a prediction prompt when given', () => {
    const { emit, drain } = createTracer();
    emit(
      'with prompt',
      { stage: 'buffer', action: 'evict', frameId: 0, victimPageId: 2, pageId: 9 },
      {
        predictable: {
          question: 'Which frame goes?',
          options: [{ id: 'f0', label: 'Frame 0' }],
          correctOptionId: 'f0',
          explanation: 'It was least recently used.',
        },
      },
    );
    expect(drain()[0]?.predictable?.correctOptionId).toBe('f0');
  });

  it('drain returns a copy, so later emits cannot mutate a taken trace', () => {
    const { emit, drain } = createTracer();
    emit('first', { stage: 'result', rows: [] });
    const taken = drain();
    emit('second', { stage: 'result', rows: [] });
    expect(taken).toHaveLength(1);
  });
});
