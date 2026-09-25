import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assignArms, buildPack, collate, extractInstrument, main, makeLinks, minDetectableD, parseCsv, renderPerf, summarise, summarisePerf,
} from '../study.ts';
import type { Instrument, Io } from '../study.ts';
import { decodePack } from '../../src/study/pack.ts';
import { encodeResult } from '../../src/study/result.ts';
import type { StudyResult } from '../../src/study/result.ts';

// Vitest runs from the repo root; `new URL(…, import.meta.url)` is a jsdom URL here, which `fs` rejects.
const STUDY_MD = readFileSync('STUDY.md', 'utf-8');
const instrument: Instrument = extractInstrument(STUDY_MD);
const opts = { study: 'unit', n: 6, seed: 'seed-1', base: 'https://example.test', materialSeconds: 720, testSeconds: 300 };

describe('extractInstrument — reads the real STUDY.md', () => {
  it('finds the five questions and a rubric that sums to 12', () => {
    expect(instrument.questions.map((q) => q.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
    expect(instrument.points).toEqual([2, 2, 3, 2, 3]);
    expect(instrument.points.reduce((a, b) => a + b, 0)).toBe(12);
    expect(instrument.questions.every((q) => q.text.length > 100 && q.title.length > 3)).toBe(true);
  });

  it('extracts the control text without its markers, wrapped lines unwrapped', () => {
    expect(instrument.control).not.toMatch(/CONTROL TEXT/);
    expect(instrument.control).toMatch(/^### How a database decides what to keep in memory/);
    expect(instrument.control.split('\n\n').filter((b) => b.startsWith('### '))).toHaveLength(3);
    expect(instrument.control).not.toMatch(/[^\n]\n[^\n]/); // only blank-line breaks remain
  });

  it("keeps STUDY.md's own rule: the control reading has no links and never points at the app", () => {
    expect(instrument.control).not.toMatch(/https?:\/\//);
    expect(instrument.control).not.toMatch(/QueryLens|click|open the/i);
  });

  it('refuses a STUDY.md it cannot read', () => {
    expect(() => extractInstrument('# nothing here')).toThrow(/CONTROL TEXT/);
    expect(() => extractInstrument(STUDY_MD.replace(/\| \*\*Q3\*\* \| 3 \|/, '| **Q3** | x |'))).toThrow(/do not line up/);
  });
});

describe('assignArms', () => {
  const count = (arms: string[], arm: string) => arms.filter((a) => a === arm).length;

  it('makes equal groups for an even n, and groups within one for an odd n', () => {
    for (const n of [2, 6, 12, 20]) {
      const arms = assignArms(n, 's');
      expect(count(arms, 'app')).toBe(n / 2);
      expect(count(arms, 'text')).toBe(n / 2);
    }
    for (const n of [3, 7, 11]) {
      const arms = assignArms(n, 's');
      expect(Math.abs(count(arms, 'app') - count(arms, 'text'))).toBe(1);
    }
  });

  it('is reproducible from its seed, and differs across seeds', () => {
    expect(assignArms(12, 'same')).toEqual(assignArms(12, 'same'));
    const seen = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((s) => assignArms(12, s).join('')));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('makeLinks', () => {
  it('issues one decodable link per participant, with the right material for each arm', async () => {
    const rows = await makeLinks(instrument, opts);
    expect(rows.map((r) => r.pid)).toEqual(['P01', 'P02', 'P03', 'P04', 'P05', 'P06']);
    for (const row of rows) {
      expect(row.url.startsWith('https://example.test/study#p=')).toBe(true);
      const decoded = await decodePack(row.url.split('#p=')[1] ?? '');
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) continue;
      const p = decoded.pack;
      expect([p.pid, p.arm]).toEqual([row.pid, row.arm]);
      expect(p.test.questions).toEqual(instrument.questions); // identical instrument for both arms
      expect(p.material.seconds).toBe(720);
      if (row.arm === 'text') {
        expect(p.material.body).toBe(instrument.control);
        expect(p.material.tasks).toEqual([]);
      } else {
        expect(p.material.body).toBe('');
        expect(p.material.tasks.map((t) => t.href)).toEqual(['/learn/eviction', '/learn/btree-split']);
      }
    }
  });

  it('never puts the answers or the rubric into a link', () => {
    const pack = buildPack(instrument, 'text', 'P01', opts);
    const wire = JSON.stringify(pack);
    expect(wire).not.toMatch(/rubric|Correct answer|key points|Award for/i);
  });
});

/* ----- collate / report ------------------------------------------------------ */

async function code(pid: string, arm: 'app' | 'text', answers: Record<string, string>, extra: Partial<StudyResult> = {}) {
  return encodeResult({
    v: 1, study: 'unit', pid, arm,
    startedAt: '2026-10-01T10:00:00.000Z', finishedAt: '2026-10-01T10:20:00.000Z',
    materialSeconds: 720, testSeconds: 300, testUsedSeconds: 240, timedOut: false,
    answers: instrument.questions.map((q) => ({ id: q.id, text: answers[q.id] ?? '' })),
    build: 'abc', ...extra,
  });
}

const KEY = 'pid,arm,url\nP01,app,u1\nP02,text,u2\nP03,app,u3\nP04,text,u4\n';

describe('collate', () => {
  it('writes a blind sheet that hides who and which arm, plus a private map', async () => {
    const lines = [
      await code('P01', 'app', { q1: 'the scan reads more' }),
      await code('P02', 'text', { q2: 'page 3' }),
      await code('P03', 'app', { q3: 'LRU evicts A' }),
      await code('P04', 'text', {}, { timedOut: true }),
    ];
    const c = await collate(KEY, lines, 'seed', instrument);
    expect(c.problems).toEqual([]);
    expect(c.accepted).toBe(4);

    // Blind: no participant code, no arm names — and the scorer can see the max points.
    expect(c.blind).not.toMatch(/P0\d/);
    expect(c.blind).not.toMatch(/\b(app|text)\b/i);
    expect(c.blind).toMatch(/## R01/);
    expect(c.blind).toMatch(/Score: ____ \/ 3/);
    expect(c.blind).toMatch(/_\(no answer\)_/);
    expect(c.blind).toMatch(/> the scan reads more/);

    // The map is what un-blinds: every participant appears once, with their arm.
    const map = parseCsv(c.map);
    expect(map.map((r) => r.pid).sort()).toEqual(['P01', 'P02', 'P03', 'P04']);
    expect(map.find((r) => r.pid === 'P02')?.arm).toBe('text');
    expect(map.find((r) => r.pid === 'P04')?.timedOut).toBe('true');

    // A scores template with one row per code and one column per question.
    expect(c.scoresTemplate.split('\n')[0]).toBe('code,q1,q2,q3,q4,q5');
    expect(parseCsv(c.scoresTemplate)).toHaveLength(4);
  });

  it('is deterministic for a seed, and shuffles across seeds', async () => {
    const lines = [await code('P01', 'app', {}), await code('P02', 'text', {}), await code('P03', 'app', {}), await code('P04', 'text', {})];
    const a = await collate(KEY, lines, 's1', instrument);
    expect(a.map).toBe((await collate(KEY, lines, 's1', instrument)).map);
    const orders = new Set(await Promise.all(['a', 'b', 'c', 'd', 'e'].map(async (s) => (await collate(KEY, lines, s, instrument)).map)));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('reports — rather than swallows — malformed, unknown, mismatched and duplicate results', async () => {
    const good = await code('P01', 'app', {});
    const c = await collate(
      KEY,
      [
        '# a comment and a blank line are fine', '',
        good,
        good, // duplicate
        'QLS1.garbage',
        'no prefix at all',
        await code('P99', 'app', {}), // not in the key
        await code('P02', 'app', {}), // arm disagrees with the key
      ],
      's',
      instrument,
    );
    expect(c.accepted).toBe(1);
    expect(c.problems.join('\n')).toMatch(/duplicate result for P01/);
    expect(c.problems.join('\n')).toMatch(/P99 is not in the key/);
    expect(c.problems.join('\n')).toMatch(/P02's arm disagrees/);
    expect(c.problems.filter((p) => /damaged|does not start/.test(p))).toHaveLength(2);
  });
});

describe('opt-in responsiveness in collate and report (plan.md §25.4 A6)', () => {
  const perf = (inp: number | null) => ({ inp, interactions: 70, cores: 8, viewportPx: 1280, touch: false });

  it('puts INP in the private map — never the blind sheet — and leaves it empty for anyone who did not opt in', async () => {
    const lines = [
      await code('P01', 'app', { q1: 'a' }, { perf: perf(240) }),
      await code('P02', 'text', { q2: 'b' }),
      await code('P03', 'app', { q3: 'c' }, { perf: perf(null) }),
      await code('P04', 'text', {}),
    ];
    const c = await collate(KEY, lines, 'seed', instrument);
    expect(c.problems).toEqual([]);
    const map = parseCsv(c.map);
    const row = (pid: string) => map.find((r) => r.pid === pid)!;
    expect(row('P01')).toMatchObject({ perf: 'ok', inpMs: '240', interactions: '70', cores: '8', viewportPx: '1280', touch: 'false' });
    expect(row('P02')).toMatchObject({ perf: '', inpMs: '' });
    expect(row('P03')).toMatchObject({ perf: 'none', inpMs: '' });
    // The scorer must learn nothing about arm, participant or device.
    expect(c.blind).not.toMatch(/\b(240|inp|cores|viewportPx|touch)\b/i);
  });

  const MAP = [
    'code,pid,arm,materialSeconds,testUsedSeconds,timedOut,perf,inpMs,interactions,cores,viewportPx,touch',
    'R01,P01,app,720,240,false,ok,120,60,8,1280,false',
    'R02,P03,app,720,240,false,ok,350,40,4,390,true',
    'R03,P05,app,720,240,false,ok,900,20,4,390,true',
    'R04,P07,app,720,240,false,none,,0,4,390,true',
    'R05,P02,text,720,240,false,,,,,,',
  ].join('\n');

  it('summarises INP per arm for those who opted in, independent of scoring', () => {
    const rows = summarisePerf(MAP);
    expect(rows).toHaveLength(1); // the text arm has nobody who opted in
    expect(rows[0]).toMatchObject({ arm: 'app', optedIn: 4, measured: 3, median: 350, worst: 900, good: 1, needsImprovement: 1, poor: 1 });
  });

  it('renders a table with the honest caveat, and nothing at all when nobody opted in', () => {
    const text = renderPerf(summarisePerf(MAP));
    expect(text).toMatch(/Responsiveness/);
    expect(text).toMatch(/app\s+4\s+3\s+350\s+900\s+1\s+1\s+1/);
    expect(text).toMatch(/anecdote/);
    expect(renderPerf(summarisePerf('code,pid,arm,perf\nR01,P01,app,\n'))).toBe('');
  });

  it('the report command appends it after the scores', async () => {
    const scores = 'code,q1,q2,q3,q4,q5\nR01,1,1,1,1,1\nR02,1,1,1,1,1\nR03,1,1,1,1,1\nR04,1,1,1,1,1\nR05,1,1,1,1,1\n';
    const m = memoryIo({ 'map.csv': MAP, 'scores.csv': scores });
    expect(await run(['report', '--map', 'map.csv', '--scores', 'scores.csv'], m)).toBe(0);
    expect(m.out()).toMatch(/Responsiveness — INP, opt-in participants only/);
  });
});

describe('summarise', () => {
  const MAP = 'code,pid,arm,materialSeconds,testUsedSeconds,timedOut\nR01,P01,app,720,200,false\nR02,P02,text,720,300,true\nR03,P03,app,720,250,false\nR04,P04,text,720,250,false\n';

  it('reports per-arm n, mean, SD, min and max — no p-value', () => {
    const scores = 'code,q1,q2,q3,q4,q5\nR01,2,2,3,2,3\nR02,1,1,1,1,1\nR03,2,2,2,2,2\nR04,0,1,1,0,1\n';
    const { arms, problems } = summarise(MAP, scores, instrument.points);
    expect(problems).toEqual([]);
    const app = arms.find((a) => a.arm === 'app');
    const text = arms.find((a) => a.arm === 'text');
    expect(app).toMatchObject({ n: 2, mean: 11, min: 10, max: 12, timedOut: 0 });
    expect(text).toMatchObject({ n: 2, mean: 4, min: 3, max: 5, timedOut: 1 });
    expect(app?.sd).toBeCloseTo(Math.SQRT2, 5);
  });

  it('flags a score that is out of range, missing or not scored yet — and leaves that person out', () => {
    const scores = 'code,q1,q2,q3,q4,q5\nR01,9,2,3,2,3\nR02,,1,1,1,1\n';
    const { arms, problems } = summarise(MAP, scores, instrument.points);
    expect(problems.join('\n')).toMatch(/R01: q1 must be a number from 0 to 2/);
    expect(problems.join('\n')).toMatch(/R02: q1 must be a number/);
    expect(problems.join('\n')).toMatch(/R03: not scored yet/);
    expect(arms).toEqual([]);
  });

  it('is honest about what a small study can detect', () => {
    expect(minDetectableD(10)).toBeCloseTo(1.25, 1);
    expect(minDetectableD(63)).toBeCloseTo(0.5, 1);
  });
});

/* ----- the command line ------------------------------------------------------ */

function memoryIo(files: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    read: (p) => { const f = files[p]; if (f === undefined) throw new Error(`no such file ${p}`); return f; },
    write: (p, t) => { files[p] = t; },
    exists: (p) => p in files,
    out: (t) => { out.push(t); },
    err: (t) => { err.push(t); },
  };
  return { io, files, out: () => out.join(''), err: () => err.join('') };
}
const run = (argv: string[], m: ReturnType<typeof memoryIo>) => main(argv, m.io, () => STUDY_MD);

describe('pnpm study (the CLI)', () => {
  it('prints help, and a usage error for no arguments', async () => {
    const a = memoryIo();
    expect(await run(['help'], a)).toBe(0);
    expect(a.out()).toMatch(/links .*collate .*report/s);
    expect(await run([], memoryIo())).toBe(2);
  });

  it('links: validates its arguments', async () => {
    expect(await run(['links', '--n', '1', '--study', 'x'], memoryIo())).toBe(2);
    expect(await run(['links', '--n', '4'], memoryIo())).toBe(2);
    expect(await run(['links', '--n', '4', '--study', 'bad id!'], memoryIo())).toBe(2);
  });

  it('links: writes the key, reports the seed, and refuses to overwrite it without --force', async () => {
    const m = memoryIo();
    expect(await run(['links', '--study', 'pilot', '--n', '4', '--seed', 'fixed', '--base', 'https://example.test', '--out', 'key.csv'], m)).toBe(0);
    const rows = parseCsv(m.files['key.csv'] ?? '');
    expect(rows).toHaveLength(4);
    expect(m.err()).toMatch(/Seed: fixed/);
    expect(m.err()).toMatch(/Keep this file private/);

    expect(await run(['links', '--study', 'pilot', '--n', '4', '--out', 'key.csv'], m)).toBe(2);
    expect(m.err()).toMatch(/already exists/);
    expect(await run(['links', '--study', 'pilot', '--n', '4', '--out', 'key.csv', '--force'], m)).toBe(0);
  });

  it('runs the whole study end to end: links → results → collate → score → report', async () => {
    const m = memoryIo();
    await run(['links', '--study', 'e2e', '--n', '4', '--seed', 'x', '--out', 'key.csv'], m);
    const key = parseCsv(m.files['key.csv'] ?? '');

    // Each participant "finishes"; the codes they send back are pasted into one file.
    const codes: string[] = [];
    for (const [i, row] of key.entries()) {
      codes.push(await code(row.pid ?? '', row.arm === 'app' ? 'app' : 'text', { q1: `free-text answer number ${String(i)}` }, { study: 'e2e' }));
    }
    m.files['codes.txt'] = codes.join('\n');

    expect(await run(['collate', '--key', 'key.csv', '--results', 'codes.txt', '--out-dir', 'out'], m)).toBe(0);
    expect(m.files['out/blind.md']).toMatch(/Blind scoring sheet — study e2e/);
    expect(m.files['out/blind.md']).not.toMatch(/P0\d/);
    const template = parseCsv(m.files['out/scores-template.csv'] ?? '');
    expect(template).toHaveLength(4);

    // The researcher scores blind, then reports.
    m.files['scores.csv'] = 'code,q1,q2,q3,q4,q5\n' + template.map((r) => `${r.code ?? ''},1,1,1,1,1`).join('\n') + '\n';
    expect(await run(['report', '--map', 'out/map.csv', '--scores', 'scores.csv'], m)).toBe(0);
    expect(m.out()).toMatch(/app +2 +5\.00/);
    expect(m.out()).toMatch(/text +2 +5\.00/);
    expect(m.out()).toMatch(/Scores are out of 12/);
    expect(m.out()).toMatch(/exploratory signal/);
  });

  it('collate exits non-zero when any result was rejected, but still writes the good ones', async () => {
    const m = memoryIo({ 'key.csv': KEY, 'codes.txt': `${await code('P01', 'app', {})}\nQLS1.junk\n` });
    expect(await run(['collate', '--key', 'key.csv', '--results', 'codes.txt'], m)).toBe(1);
    expect(m.files['./blind.md']).toBeDefined();
    expect(m.err()).toMatch(/^! line 2/m);
  });
});
