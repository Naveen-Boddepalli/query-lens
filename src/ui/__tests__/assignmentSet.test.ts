import { describe, expect, it } from 'vitest';
import { serializeSet, worksheet } from '../assignmentSet.ts';

const items = [
  { label: 'Predict the eviction', link: 'https://x/playground?q=a&s=91&l=1' },
  { label: '', link: 'https://x/playground?q=b&s=8&l=1' },
];

describe('worksheet', () => {
  it('numbers each assignment under a class-code heading', () => {
    const out = worksheet('CS564', items);
    expect(out.startsWith('# CS564 — assignment set\n')).toBe(true);
    expect(out).toContain('1. **Predict the eviction** — https://x/playground?q=a&s=91&l=1');
    // A blank label falls back to a number.
    expect(out).toContain('2. **Assignment 2** — https://x/playground?q=b&s=8&l=1');
  });

  it('drops the code from the heading when it is blank', () => {
    expect(worksheet('   ', items).startsWith('# Assignment set\n')).toBe(true);
  });
});

describe('serializeSet', () => {
  it('is a versioned JSON object with trimmed fields', () => {
    const o = JSON.parse(serializeSet('  CS564  ', items)) as Record<string, unknown>;
    expect(o.kind).toBe('querylens/assignment-set');
    expect(o.version).toBe(1);
    expect(o.code).toBe('CS564');
    expect((o.assignments as unknown[]).length).toBe(2);
  });
});
