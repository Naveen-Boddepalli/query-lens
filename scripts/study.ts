#!/usr/bin/env -S node --experimental-strip-types
/**
 * `pnpm study` — the researcher's side of the §9 study kit (plan.md §25.4 A2).
 *
 * The runner at `/study` is inert without a pack, and the instrument — the
 * control-arm reading and the five mechanism questions — lives only in
 * `STUDY.md`, participant-blind. This script is the bridge, in three steps:
 *
 *   pnpm study links   --study pilot-1 --n 12       one personal link per participant
 *   pnpm study collate --key key.csv --results codes.txt   a blind scoring sheet
 *   pnpm study report  --map map.csv --scores scores.csv   descriptive results
 *
 * Nothing here touches a network. `links` reads `STUDY.md`, assigns arms by
 * seeded random allocation into equal groups, and writes a *key* (`pid,arm,url`)
 * you keep private; `collate` reads the result codes participants sent back and
 * writes a scoring sheet with the arm and the participant stripped out
 * (STUDY.md §3: "score blind") plus a separate map; `report` joins your scores
 * to the map and prints per-arm summaries — deliberately without a p-value.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encodePack, PACK_VERSION } from '../src/study/pack.ts';
import type { StudyArm, StudyPack, StudyQuestion } from '../src/study/pack.ts';
import { decodeResult } from '../src/study/result.ts';
import type { StudyResult } from '../src/study/result.ts';

/* ----- the instrument, extracted from STUDY.md ------------------------------ */

export interface Instrument {
  /** The control-arm reading: `### ` headings and blank-line-separated paragraphs. */
  control: string;
  questions: StudyQuestion[];
  /** Maximum points per question, from the rubric table, in question order. */
  points: number[];
}

const unwrap = (lines: string[]): string => lines.join(' ').replace(/\s+/g, ' ').trim();

export function extractInstrument(md: string): Instrument {
  const controlMatch = /<!-- CONTROL TEXT START -->([\s\S]*?)<!-- CONTROL TEXT END -->/.exec(md);
  if (!controlMatch?.[1]) throw new Error('STUDY.md has no CONTROL TEXT markers');
  const control = controlMatch[1]
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '')
    .map((chunk) => (chunk.startsWith('### ') ? chunk : unwrap(chunk.split('\n'))))
    .join('\n\n');

  const questions: StudyQuestion[] = [];
  const question = /^\*\*Q(\d+) — (.+?)\.\*\*[ \t]*\n((?:>.*(?:\n|$))+)/gm;
  for (let m = question.exec(md); m !== null; m = question.exec(md)) {
    const [, n, title, quote] = m;
    if (n === undefined || title === undefined || quote === undefined) continue;
    const text = unwrap(quote.split('\n').map((l) => l.replace(/^>\s?/, '')));
    questions.push({ id: `q${n}`, title, text });
  }

  const points: number[] = [];
  const row = /^\|\s*\*\*Q(\d+)\*\*\s*\|\s*(\d+)\s*\|/gm;
  for (let m = row.exec(md); m !== null; m = row.exec(md)) {
    const [, n, pts] = m;
    if (n !== undefined && pts !== undefined) points[Number(n) - 1] = Number(pts);
  }

  if (questions.length === 0) throw new Error('STUDY.md has no mechanism questions');
  // Index, don't `.some()`: `.some` skips the hole a missing rubric row leaves behind.
  if (points.length !== questions.length || questions.some((_, i) => !Number.isInteger(points[i]))) {
    throw new Error('STUDY.md rubric and questions do not line up');
  }
  return { control, questions, points };
}

/* ----- allocation ------------------------------------------------------------- */

/** FNV-1a, so a text seed becomes a 32-bit state. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, seedable, and good enough to shuffle a study roster. */
function rng(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/** Equal-sized groups (±1 when `n` is odd), in random order. The seed makes it reproducible. */
export function assignArms(n: number, seed: string): StudyArm[] {
  const arms: StudyArm[] = [];
  for (let i = 0; i < n; i++) arms.push(i % 2 === 0 ? 'app' : 'text');
  const shuffled = shuffle(arms, `arms:${seed}`);
  // With an odd n the extra participant goes to a random arm, not always `app`.
  if (n % 2 === 1 && rng(`odd:${seed}`)() < 0.5) return shuffled.map((a) => (a === 'app' ? 'text' : 'app'));
  return shuffled;
}

/* ----- links --------------------------------------------------------------- */

/** Plain-language consent. A template, not legal or ethics advice — see STUDY.md §4. */
export const CONSENT_TEMPLATE: string[] = [
  'This is a short study about how people learn how databases work. It takes about 20 minutes: some time with a piece of learning material, then a few written questions.',
  'You have been given a code (not your name). Your answers and how long each part took are kept in this browser until you choose to copy them into a message to the researcher. This page does not send anything over the internet.',
  'Taking part is voluntary and you can stop at any time by closing this tab. It is not a test of you — the questions help compare two ways of learning the same material, so please answer from what you remember, without looking anything up.',
  'By ticking the box below and continuing, you agree to take part on these terms.',
];

export interface LinkOptions {
  study: string;
  n: number;
  seed: string;
  base: string;
  materialSeconds: number;
  testSeconds: number;
  consent?: string[];
}

export interface LinkRow {
  pid: string;
  arm: StudyArm;
  url: string;
}

export function buildPack(instrument: Instrument, arm: StudyArm, pid: string, o: LinkOptions): StudyPack {
  const material: StudyPack['material'] =
    arm === 'text'
      ? {
          seconds: o.materialSeconds,
          title: 'Read this carefully',
          intro: 'You have a fixed amount of time to read the text below. Read it the way you would to learn the material.',
          body: instrument.control,
          tasks: [],
        }
      : {
          seconds: o.materialSeconds,
          title: 'Learn with QueryLens',
          intro:
            'Use QueryLens to learn how a database decides what to keep in memory, and how an index tree splits. Open each lesson below in a new tab and work through it, including the last step. Please stay within these lessons and the Playground. Come back to this tab when the time is up.',
          body: '',
          tasks: [
            { label: 'Lesson: Watch a page get evicted', href: '/learn/eviction' },
            { label: 'Lesson: Watch a B+Tree split', href: '/learn/btree-split' },
          ],
        };
  return {
    v: PACK_VERSION,
    study: o.study,
    pid,
    arm,
    consent: o.consent ?? CONSENT_TEMPLATE,
    material,
    test: { seconds: o.testSeconds, questions: instrument.questions },
  };
}

export async function makeLinks(instrument: Instrument, o: LinkOptions): Promise<LinkRow[]> {
  const arms = assignArms(o.n, o.seed);
  const rows: LinkRow[] = [];
  for (let i = 0; i < o.n; i++) {
    const arm: StudyArm = arms[i] === 'text' ? 'text' : 'app';
    const pid = `P${String(i + 1).padStart(2, '0')}`;
    const code = await encodePack(buildPack(instrument, arm, pid, o));
    rows.push({ pid, arm, url: `${o.base.replace(/\/$/, '')}/study#p=${code}` });
  }
  return rows;
}

/* ----- csv (no quoting needed: every field is an id, a number or a URL-safe string) ---- */

export function toCsv(header: string[], rows: string[][]): string {
  return [header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const head = (lines[0] ?? '').split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

/* ----- collate: results → a blind scoring sheet + a private map ---------------- */

export interface Collated {
  blind: string;
  map: string;
  scoresTemplate: string;
  problems: string[];
  accepted: number;
}

export async function collate(
  keyCsv: string,
  resultLines: string[],
  seed: string,
  instrument: Instrument,
): Promise<Collated> {
  const key = new Map(parseCsv(keyCsv).map((r) => [r.pid ?? '', r.arm ?? '']));
  const problems: string[] = [];
  const accepted = new Map<string, StudyResult>();

  for (const [i, raw] of resultLines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parsed = await decodeResult(line);
    if (!parsed.ok) {
      problems.push(`line ${String(i + 1)}: ${parsed.error}`);
      continue;
    }
    const r = parsed.result;
    if (!key.has(r.pid)) problems.push(`line ${String(i + 1)}: participant ${r.pid} is not in the key`);
    else if (key.get(r.pid) !== r.arm) problems.push(`line ${String(i + 1)}: ${r.pid}'s arm disagrees with the key`);
    else if (accepted.has(r.pid)) problems.push(`line ${String(i + 1)}: duplicate result for ${r.pid} (kept the first)`);
    else accepted.set(r.pid, r);
  }

  const studies = new Set([...accepted.values()].map((r) => r.study));
  if (studies.size > 1) problems.push(`results come from more than one study: ${[...studies].join(', ')}`);

  const order = shuffle([...accepted.values()], `collate:${seed}`);
  const codes = order.map((_, i) => `R${String(i + 1).padStart(2, '0')}`);
  const qids = instrument.questions.map((q) => q.id);

  const blind: string[] = [
    `# Blind scoring sheet${studies.size === 1 ? ` — study ${[...studies][0] ?? ''}` : ''}`,
    '',
    'The participant and the arm are hidden, and responses are in random order. Score every answer against the',
    'rubric in `STUDY.md` §3, then record the points in `scores.csv` (one column per question). Keep `map.csv`',
    'closed until every response is scored.',
    '',
  ];
  order.forEach((r, i) => {
    blind.push(`## ${codes[i] ?? ''}`, '');
    instrument.questions.forEach((q, qi) => {
      const answer = r.answers.find((a) => a.id === q.id)?.text.trim() ?? '';
      blind.push(`**${q.id.toUpperCase()} — ${q.title}** (max ${String(instrument.points[qi] ?? 0)})`, '');
      blind.push(answer === '' ? '_(no answer)_' : answer.split('\n').map((l) => `> ${l}`).join('\n'), '');
      blind.push(`Score: ____ / ${String(instrument.points[qi] ?? 0)}`, '');
    });
  });

  const map = toCsv(
    ['code', 'pid', 'arm', 'materialSeconds', 'testUsedSeconds', 'timedOut'],
    order.map((r, i) => [codes[i] ?? '', r.pid, r.arm, String(r.materialSeconds), String(r.testUsedSeconds), String(r.timedOut)]),
  );
  const scoresTemplate = toCsv(['code', ...qids], codes.map((c) => [c, ...qids.map(() => '')]));

  return { blind: blind.join('\n') + '\n', map, scoresTemplate, problems, accepted: order.length };
}

/* ----- report: descriptive, deliberately without a p-value ------------------- */

export interface ArmSummary {
  arm: StudyArm;
  n: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  timedOut: number;
}

export function summarise(mapCsv: string, scoresCsv: string, points: number[]): { arms: ArmSummary[]; problems: string[] } {
  const scores = new Map(parseCsv(scoresCsv).map((r) => [r.code ?? '', r]));
  const problems: string[] = [];
  const byArm = new Map<StudyArm, { totals: number[]; timedOut: number }>();

  for (const m of parseCsv(mapCsv)) {
    const code = m.code ?? '';
    const arm = m.arm === 'app' || m.arm === 'text' ? m.arm : null;
    const row = scores.get(code);
    if (!arm) { problems.push(`${code}: unknown arm`); continue; }
    if (!row) { problems.push(`${code}: not scored yet`); continue; }
    let total = 0;
    let ok = true;
    for (const [qi, max] of points.entries()) {
      const cell = (row[`q${String(qi + 1)}`] ?? '').trim();
      const v = Number(cell);
      if (cell === '' || !Number.isFinite(v) || v < 0 || v > max) {
        problems.push(`${code}: q${String(qi + 1)} must be a number from 0 to ${String(max)}`);
        ok = false;
      } else {
        total += v;
      }
    }
    if (!ok) continue;
    const bucket = byArm.get(arm) ?? { totals: [], timedOut: 0 };
    bucket.totals.push(total);
    if (m.timedOut === 'true') bucket.timedOut += 1;
    byArm.set(arm, bucket);
  }

  const arms: ArmSummary[] = [];
  for (const [arm, { totals, timedOut }] of byArm) {
    const n = totals.length;
    const mean = totals.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    arms.push({ arm, n, mean, sd, min: Math.min(...totals), max: Math.max(...totals), timedOut });
  }
  arms.sort((a, b) => a.arm.localeCompare(b.arm));
  return { arms, problems };
}

/** The smallest standardised difference detectable at 80% power, α = .05, two-sided, equal groups. */
export function minDetectableD(nPerArm: number): number {
  return Math.sqrt(15.68 / nPerArm);
}

export function renderReport(arms: ArmSummary[], totalPoints: number): string {
  const lines = ['arm    n   mean     sd    min   max  timed-out', '-----  --  -----  -----  ----  ----  ---------'];
  for (const a of arms) {
    lines.push(
      `${a.arm.padEnd(5)}  ${String(a.n).padStart(2)}  ${a.mean.toFixed(2).padStart(5)}  ${a.sd.toFixed(2).padStart(5)}  ${String(a.min).padStart(4)}  ${String(a.max).padStart(4)}  ${String(a.timedOut).padStart(9)}`,
    );
  }
  const smallest = Math.min(...arms.map((a) => a.n));
  lines.push('', `Scores are out of ${String(totalPoints)}.`);
  if (Number.isFinite(smallest) && smallest > 0) {
    lines.push(
      `With ${String(smallest)} per arm, only a very large difference is detectable (d ≳ ${minDetectableD(smallest).toFixed(1)} at 80% power).`,
      'Report this descriptively, as an exploratory signal — including if the text arm matches or beats the app (plan.md §25.6).',
    );
  }
  return lines.join('\n') + '\n';
}

/* ----- the command line ------------------------------------------------------ */

export interface Io {
  read(path: string): string;
  write(path: string, text: string): void;
  exists(path: string): boolean;
  out(text: string): void;
  err(text: string): void;
}

const HELP = `pnpm study — the researcher's side of the §9 study kit

  links    --study <id> --n <count> [--seed <text>] [--base <url>]
           [--material-minutes 12] [--test-minutes 5] [--out key.csv] [--force]
           One personal link per participant, arms assigned at random in equal groups.
           Writes the KEY (pid,arm,url) to --out, or stdout. Keep it private: it has the arms.

  collate  --key <key.csv> --results <codes.txt> [--out-dir .] [--seed <text>]
           Reads the result codes participants sent back (one per line). Writes
           blind.md (score this), map.csv (keep closed) and scores-template.csv.

  report   --map <map.csv> --scores <scores.csv>
           Per-arm n, mean, SD, min, max — descriptive only.

The instrument (control text, questions, rubric) is read from STUDY.md.
`;

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = 'true';
    else { out[a.slice(2)] = next; i++; }
  }
  return out;
}

const DEFAULT_BASE = 'https://query-lens.1234naveenboddepalli.workers.dev';

export async function main(argv: string[], io: Io, studyMd: () => string): Promise<number> {
  const [command, ...rest] = argv;
  const f = flags(rest);
  try {
    if (command === undefined || command === 'help' || command === '--help') {
      io.out(HELP);
      return command === undefined ? 2 : 0;
    }

    if (command === 'links') {
      const n = Number(f.n);
      const study = f.study ?? '';
      if (!Number.isInteger(n) || n < 2 || n > 200) throw new Error('--n must be a whole number from 2 to 200');
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(study)) throw new Error('--study is required (letters, digits, - and _)');
      const seed = f.seed ?? randomBytes(6).toString('hex');
      const materialSeconds = Math.round(Number(f['material-minutes'] ?? 12) * 60);
      const testSeconds = Math.round(Number(f['test-minutes'] ?? 5) * 60);
      const rows = await makeLinks(extractInstrument(studyMd()), {
        study, n, seed, base: f.base ?? DEFAULT_BASE, materialSeconds, testSeconds,
      });
      const csv = toCsv(['pid', 'arm', 'url'], rows.map((r) => [r.pid, r.arm, r.url]));
      if (f.out !== undefined && f.out !== 'true') {
        if (io.exists(f.out) && f.force !== 'true') throw new Error(`${f.out} already exists — it holds your arm assignments; pass --force to overwrite`);
        io.write(f.out, csv);
        io.err(`Wrote ${String(rows.length)} links to ${f.out}. Seed: ${seed}. Keep this file private: it records each participant's arm.\n`);
      } else {
        io.out(csv);
        io.err(`Seed: ${seed}. Redirect stdout to a file and keep it private: it records each participant's arm.\n`);
      }
      return 0;
    }

    if (command === 'collate') {
      if (!f.key || !f.results) throw new Error('collate needs --key and --results');
      const dir = (f['out-dir'] ?? '.').replace(/\/$/, '');
      const c = await collate(io.read(f.key), io.read(f.results).split(/\r?\n/), f.seed ?? 'collate', extractInstrument(studyMd()));
      for (const p of c.problems) io.err(`! ${p}\n`);
      if (c.accepted === 0) throw new Error('no valid results to collate');
      io.write(`${dir}/blind.md`, c.blind);
      io.write(`${dir}/map.csv`, c.map);
      io.write(`${dir}/scores-template.csv`, c.scoresTemplate);
      io.err(`Collated ${String(c.accepted)} results → ${dir}/blind.md (score this), map.csv (keep closed), scores-template.csv (fill in as scores.csv).\n`);
      return c.problems.length > 0 ? 1 : 0;
    }

    if (command === 'report') {
      if (!f.map || !f.scores) throw new Error('report needs --map and --scores');
      const instrument = extractInstrument(studyMd());
      const { arms, problems } = summarise(io.read(f.map), io.read(f.scores), instrument.points);
      for (const p of problems) io.err(`! ${p}\n`);
      if (arms.length === 0) throw new Error('nothing to report yet');
      io.out(renderReport(arms, instrument.points.reduce((a, b) => a + b, 0)));
      return problems.length > 0 ? 1 : 0;
    }

    throw new Error(`unknown command "${command}"`);
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n\n${HELP}`);
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const io: Io = {
    read: (p) => readFileSync(p, 'utf-8'),
    write: (p, t) => { writeFileSync(p, t); },
    exists: (p) => existsSync(p),
    out: (t) => { process.stdout.write(t); },
    err: (t) => { process.stderr.write(t); },
  };
  process.exit(await main(process.argv.slice(2), io, () => readFileSync(new URL('../STUDY.md', import.meta.url), 'utf-8')));
}
