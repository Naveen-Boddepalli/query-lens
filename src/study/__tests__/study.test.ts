import { describe, expect, it } from 'vitest';
import { MAX_INFLATED_BYTES, pack as packJson, unpack } from '../codec.ts';
import { decodePack, encodePack, packCodeFromHash, validatePack } from '../pack.ts';
import type { StudyPack } from '../pack.ts';
import { decodeResult, encodeResult, MAX_ANSWER, parsePerf, RESULT_PREFIX } from '../result.ts';
import {
  agree, canStartTest, finish, formatClock, materialLeft, newSession, parseSession, secondsLeft,
  setAnswer, startTest, testLeft, tick, toResult,
} from '../session.ts';
import { parseBlocks, parseInline } from '../blocks.ts';

const PACK: StudyPack = {
  v: 1,
  study: 'unit-1',
  pid: 'P01',
  arm: 'text',
  consent: ['You may stop at any time.'],
  material: { seconds: 60, title: 'Read', intro: 'Read this.', body: '### A heading\n\nSome **bold** prose.', tasks: [] },
  test: {
    seconds: 30,
    questions: [
      { id: 'q1', title: 'First', text: 'What is `LRU`?' },
      { id: 'q2', title: 'Second', text: 'Explain *why*.' },
    ],
  },
};

const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(PACK)) as Record<string, unknown>;

/** Sets `a.b.0.c`-style paths on a plain object, so a test can break exactly one field. */
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = root;
  for (const key of keys.slice(0, -1)) cur = cur[key] as Record<string, unknown>;
  cur[keys[keys.length - 1] ?? ''] = value;
}

type Edit = [path: string, value: unknown];
const reject = (...edits: Edit[]) => {
  const p = clone();
  for (const [path, value] of edits) setPath(p, path, value);
  return validatePack(p);
};

const APP_ARM: Edit[] = [['arm', 'app'], ['material.body', '']];
const tasks = (href: string): Edit[] => [...APP_ARM, ['material.tasks', [{ label: 'L', href }]]];

describe('codec', () => {
  it('round-trips any JSON value, including non-ASCII text', async () => {
    const value = { a: [1, 2, 3], s: 'B+Tree — “copy-up” ✓', n: null };
    expect(await unpack(await packJson(value))).toEqual(value);
  });

  it('is URL-safe: no +, / or = in the output', async () => {
    const code = await packJson({ x: '>>>???~~~'.repeat(400) });
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns null — never throws — for garbage', async () => {
    expect(await unpack('not base64 at all!')).toBeNull();
    expect(await unpack('AAAA')).toBeNull(); // valid base64url, not deflate
    expect(await unpack('')).toBeNull();
  });

  it('refuses a decompression bomb instead of inflating it', async () => {
    const bomb = await packJson('0'.repeat(MAX_INFLATED_BYTES * 2));
    expect(bomb.length).toBeLessThan(2000); // tiny on the wire…
    expect(await unpack(bomb)).toBeNull(); // …enormous if inflated
  });
});

describe('packs', () => {
  it('round-trips through encode → decode', async () => {
    const decoded = await decodePack(await encodePack(PACK));
    expect(decoded).toEqual({ ok: true, pack: PACK });
  });

  it('reads the pack code out of a location hash, and nothing else', () => {
    expect(packCodeFromHash('#p=abc_DEF-123')).toBe('abc_DEF-123');
    expect(packCodeFromHash('')).toBeNull();
    expect(packCodeFromHash('#other=abc')).toBeNull();
    expect(packCodeFromHash('#p=abc def')).toBeNull();
    expect(packCodeFromHash('#p=<script>')).toBeNull();
  });

  it('reports a damaged link in plain words', async () => {
    const r = await decodePack('AAAA');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/damaged or incomplete/);
  });

  it.each<[string, Edit[]]>([
    ['a different version', [['v', 2]]],
    ['an unknown arm', [['arm', 'both']]],
    ['an id with spaces', [['pid', 'P 01']]],
    ['no consent text', [['consent', []]]],
    ['no questions', [['test.questions', []]]],
    ['duplicate question ids', [['test.questions.1.id', 'q1']]],
    ['a text arm with no reading', [['material.body', '  ']]],
    ['too little material time', [['material.seconds', 1]]],
    ['a fractional time', [['test.seconds', 30.5]]],
    ['an oversize reading', [['material.body', 'x'.repeat(30_000)]]],
    ['too many questions', [['test.questions', Array.from({ length: 9 }, (_, i) => ({ id: `q${String(i)}`, title: 't', text: 't' }))]]],
  ])('rejects %s', (_name, edits) => {
    expect(reject(...edits).ok).toBe(false);
  });

  it('requires at least one task for the app arm', () => {
    expect(reject(...APP_ARM, ['material.tasks', []]).ok).toBe(false);
  });

  it.each([
    'https://evil.test/learn',
    '//evil.test/learn',
    'javascript:alert(1)',
    'data:text/html,<script>',
    '/learn/../../etc',
    '/learn/eviction\nX',
    'learn/eviction',
  ])('rejects the task link %j — a crafted link cannot send a participant off-site', (href) => {
    expect(reject(...tasks(href)).ok).toBe(false);
  });

  it('accepts same-origin paths, with an optional query', () => {
    for (const href of ['/learn/eviction', '/tools/btree?fanout=4']) {
      expect(reject(...tasks(href)).ok).toBe(true);
    }
  });
});

describe('results', () => {
  const session = () => {
    let s = newSession('code', PACK);
    s = agree(s, 1_000);
    s = startTest(s, 61_000);
    s = setAnswer(s, 'q1', 'least recently used');
    return finish(s, 91_000, false);
  };

  it('round-trips, and carries the arm for the researcher', async () => {
    const result = toResult(session(), 'abc123');
    expect(result).not.toBeNull();
    const code = await encodeResult(result!);
    expect(code.startsWith(RESULT_PREFIX)).toBe(true);
    const back = await decodeResult(code);
    expect(back).toEqual({ ok: true, result });
    if (back.ok) {
      expect(back.result.arm).toBe('text');
      expect(back.result.answers).toEqual([
        { id: 'q1', text: 'least recently used' },
        { id: 'q2', text: '' },
      ]);
      expect(back.result.testUsedSeconds).toBe(30);
    }
  });

  it('demands the prefix, and rejects tampered fields', async () => {
    const code = await encodeResult(toResult(session(), 'b')!);
    expect((await decodeResult(code.slice(RESULT_PREFIX.length))).ok).toBe(false);
    expect((await decodeResult(`${RESULT_PREFIX}AAAA`)).ok).toBe(false);
    const bad = await packJson({ v: 1, study: 's', pid: 'P', arm: 'app', answers: 'nope' });
    expect((await decodeResult(RESULT_PREFIX + bad)).ok).toBe(false);
    const long = await packJson({
      v: 1, study: 's', pid: 'P', arm: 'app', startedAt: 'a', finishedAt: 'b', materialSeconds: 1,
      testSeconds: 1, testUsedSeconds: 1, timedOut: false, build: 'b',
      answers: [{ id: 'q1', text: 'x'.repeat(MAX_ANSWER + 1) }],
    });
    expect((await decodeResult(RESULT_PREFIX + long)).ok).toBe(false);
  });
});

describe('opt-in responsiveness timing (plan.md §25.4 A6)', () => {
  const PERF = { inp: 240, interactions: 88, cores: 8, viewportPx: 1280, touch: false };
  const done = (optIn: boolean) => {
    let s = agree(newSession('code', PACK), 1_000, optIn);
    s = startTest(s, 61_000);
    return finish(s, 91_000, false);
  };

  it('is off unless the participant ticked the separate box', () => {
    expect(newSession('c', PACK).perfOptIn).toBe(false);
    expect(agree(newSession('c', PACK), 1_000).perfOptIn).toBe(false);
    expect(agree(newSession('c', PACK), 1_000, true).perfOptIn).toBe(true);
  });

  it('adds a perf block to the result only for an opted-in participant who has a captured reading', () => {
    expect(toResult(done(true), 'b', PERF)?.perf).toEqual(PERF);
    expect(toResult(done(true), 'b', null)).not.toHaveProperty('perf');
    expect(toResult(done(true), 'b')).not.toHaveProperty('perf');
    // A reading passed for someone who did not opt in must never leak into the code.
    expect(toResult(done(false), 'b', PERF)).not.toHaveProperty('perf');
  });

  it('round-trips through the result code, and a result without one still decodes', async () => {
    const withPerf = toResult(done(true), 'b', PERF)!;
    expect(await decodeResult(await encodeResult(withPerf))).toEqual({ ok: true, result: withPerf });
    const without = toResult(done(false), 'b')!;
    expect(await decodeResult(await encodeResult(without))).toEqual({ ok: true, result: without });
  });

  it('accepts "no INP" (nothing measured) but rejects a malformed block outright', async () => {
    expect(parsePerf({ ...PERF, inp: null })).toEqual({ ...PERF, inp: null });
    for (const bad of [null, 'x', { ...PERF, inp: -1 }, { ...PERF, inp: 'fast' }, { ...PERF, cores: 1e9 }, { ...PERF, touch: 'yes' }, { inp: 1 }]) {
      expect(parsePerf(bad)).toBeNull();
    }
    const base = toResult(done(true), 'b', PERF)!;
    const tampered = await packJson({ ...base, perf: { ...PERF, inp: -5 } });
    expect((await decodeResult(RESULT_PREFIX + tampered)).ok).toBe(false);
  });

  it('a session saved before A6 (no opt-in field) still loads, as not opted in', () => {
    const { perfOptIn: _optIn, ...legacy } = newSession('c', PACK);
    expect(parseSession(JSON.parse(JSON.stringify(legacy)))).toMatchObject({ perfOptIn: false });
  });

  it('survives a save and reload with its opt-in', () => {
    expect(parseSession(JSON.parse(JSON.stringify(done(true))))).toMatchObject({ perfOptIn: true });
  });
});

describe('session protocol', () => {
  it('starts in consent and cannot skip it', () => {
    const s = newSession('c', PACK);
    expect(s.phase).toBe('consent');
    expect(startTest(s, 999_999).phase).toBe('consent');
    expect(setAnswer(s, 'q1', 'peek').answers).toEqual({});
  });

  it('gives both arms the same fixed material time — you cannot skip ahead', () => {
    let s = agree(newSession('c', PACK), 10_000);
    expect(s.phase).toBe('material');
    expect(materialLeft(s, 10_000)).toBe(60);
    expect(canStartTest(s, 40_000)).toBe(false);
    expect(startTest(s, 40_000).phase).toBe('material');
    expect(canStartTest(s, 70_000)).toBe(true);
    s = startTest(s, 70_000);
    expect(s.phase).toBe('test');
  });

  it('agreeing twice does not restart the clock', () => {
    const s = agree(newSession('c', PACK), 10_000);
    expect(agree(s, 50_000).materialStartedAt).toBe(10_000);
  });

  it('derives time from timestamps, so a reload cannot add or remove any', () => {
    expect(secondsLeft(0, 0, 60)).toBe(60);
    expect(secondsLeft(59_001, 0, 60)).toBe(1);
    expect(secondsLeft(60_000, 0, 60)).toBe(0);
    expect(secondsLeft(500_000, 0, 60)).toBe(0);
    expect(formatClock(305)).toBe('5:05');
    expect(formatClock(-3)).toBe('0:00');
  });

  it('accepts answers only during the test, only for real questions, and caps their length', () => {
    let s = startTest(agree(newSession('c', PACK), 0), 60_000);
    s = setAnswer(s, 'q1', 'a'.repeat(MAX_ANSWER + 500));
    expect(s.answers.q1?.length).toBe(MAX_ANSWER);
    expect(setAnswer(s, 'not-a-question', 'x')).toBe(s);
    const done = finish(s, 70_000, false);
    expect(setAnswer(done, 'q2', 'late')).toBe(done);
  });

  it('ends the test at its deadline and stamps the deadline, not the moment it was noticed', () => {
    const s = startTest(agree(newSession('c', PACK), 0), 60_000); // test runs 60s → 90s
    expect(tick(s, 89_000).phase).toBe('test');
    expect(testLeft(s, 89_000)).toBe(1);
    const late = tick(s, 5_000_000); // reopened long afterwards
    expect(late.phase).toBe('done');
    expect(late.timedOut).toBe(true);
    expect(late.finishedAt).toBe(90_000);
    expect(toResult(late, 'b')?.testUsedSeconds).toBe(30);
  });

  it('produces a result only once done', () => {
    const s = startTest(agree(newSession('c', PACK), 0), 60_000);
    expect(toResult(s, 'b')).toBeNull();
    expect(toResult(finish(s, 75_000, false), 'b')?.testUsedSeconds).toBe(15);
  });

  it('parses a stored session defensively', () => {
    const good = agree(newSession('c', PACK), 5);
    expect(parseSession(JSON.parse(JSON.stringify(good)))).toEqual(good);
    expect(parseSession(null)).toBeNull();
    expect(parseSession({ ...good, phase: 'hacked' })).toBeNull();
    expect(parseSession({ ...good, arm: 'both' })).toBeNull();
    expect(parseSession({ ...good, materialStartedAt: 'now' })).toBeNull();
    expect(parseSession({ ...good, answers: [] })).toBeNull();
  });
});

describe('prose blocks', () => {
  it('splits headings and unwraps paragraphs', () => {
    expect(parseBlocks('### Title\n\nfirst line\nsecond line\n\n\n### Next\n\nbody')).toEqual([
      { kind: 'heading', text: 'Title' },
      { kind: 'paragraph', text: 'first line second line' },
      { kind: 'heading', text: 'Next' },
      { kind: 'paragraph', text: 'body' },
    ]);
  });

  it('understands bold, italic and code — and nothing that could be markup', () => {
    expect(parseInline('a **b** c *d* `e` f')).toEqual([
      { kind: 'text', text: 'a ' }, { kind: 'strong', text: 'b' },
      { kind: 'text', text: ' c ' }, { kind: 'em', text: 'd' },
      { kind: 'text', text: ' ' }, { kind: 'code', text: 'e' },
      { kind: 'text', text: ' f' },
    ]);
    // HTML in a pack stays literal text; React renders it as a text node.
    expect(parseInline('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]);
  });
});
