/**
 * Generated, graded questions (plan.md §25.4 G4). Every question here is made from a seed, and its answer is *computed*
 * by the engine the question is about — the clock hand's real victim, the real split of a real B+Tree, the plan the
 * real planner picks, the visibility rule, the recovery passes — never written by hand. So the bank cannot drift from
 * the engine, and it is as large as there are seeds.
 *
 * It is deliberately disjoint from `STUDY.md`'s fixed instrument (§9): none of these asks about the study's own pool,
 * leaf or table, and `generators.test.ts` fails if a generated question ever reproduces one.
 */

import { DEFAULT_ENGINE_OPTIONS, finalPlan, runBufferTrace, runQuery } from '../../engine/index.ts';
import type { PlanNode } from '../../engine/index.ts';
import { createTree, insert } from '../../engine/index/btree.ts';
import type { BTreeNode } from '../../engine/index/btree.ts';
import { explainVisibility, isVisible } from '../../engine/mvcc.ts';
import type { Version } from '../../engine/mvcc.ts';
import { formatWalStep, runWal } from '../../engine/recovery/wal.ts';
import type { WalStep } from '../../engine/recovery/wal.ts';
import { createSeedDatabase } from '../../engine/seed.ts';
import { encodeWalSteps } from '../walUrl.ts';

export type SkillId = 'clock-victim' | 'split-separator' | 'access-path' | 'visibility' | 'redo-count' | 'losers';

export interface Skill {
  id: SkillId;
  title: string;
  /** What the skill is about, in a clause: shown beside its box. */
  about: string;
}

export const SKILLS: readonly Skill[] = [
  { id: 'clock-victim', title: 'Clock sweep', about: 'which page the clock hand evicts' },
  { id: 'split-separator', title: 'B+Tree split', about: 'which key a leaf split copies up' },
  { id: 'access-path', title: 'Access path', about: 'the scan the planner chooses' },
  { id: 'visibility', title: 'Visibility', about: 'whether a row version is visible to a snapshot' },
  { id: 'redo-count', title: 'Redo', about: 'what redo re-applies after a crash' },
  { id: 'losers', title: 'Losers', about: 'which transactions recovery must undo' },
];

export interface QuestionOption {
  id: string;
  label: string;
}

export interface Question {
  /** `skill:seed` — the same id always rebuilds the same question. */
  id: string;
  skill: SkillId;
  seed: number;
  /** One paragraph of setup, then the question. Lines are separated by `\n`. */
  prompt: string;
  options: QuestionOption[];
  answer: string;
  /** Why, in the engine's own terms, and every time the same. */
  explanation: string;
  /** A page where the same thing can be watched. */
  link?: { to: string; label: string };
}

// ── a small seeded generator ──────────────────────────────────────────────────────────────────────────────────────

/** mulberry32: the generator the standalone tools use, so a seed means the same thing everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lastIndex<T>(xs: readonly T[], pred: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i -= 1) if (pred(xs[i]!)) return i;
  return -1;
}

const int = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const options = (labels: readonly string[]): QuestionOption[] => labels.map((label, i) => ({ id: `o${String(i)}`, label }));
const idOf = (opts: QuestionOption[], label: string): string => opts.find((o) => o.label === label)!.id;

// ── clock sweep ───────────────────────────────────────────────────────────────────────────────────────────────────

function clockVictim(seed: number): Question {
  for (let attempt = 0; ; attempt += 1) {
    const r = rng(seed + attempt * 7919);
    const frames = int(r, 3, 4);
    const length = int(r, 8, 12);
    const refs = Array.from({ length }, () => int(r, 1, frames + 3));
    const trace = runBufferTrace(refs, { ...DEFAULT_ENGINE_OPTIONS, bufferFrames: frames, policy: 'clock' });
    const events = trace.events.filter((e) => e.stage === 'buffer');
    const last = events.at(-1);
    // The last request must be a miss that evicts, so that there is a victim to ask about.
    const evictAt = lastIndex(events, (e) => e.action === 'evict');
    if (!last || evictAt < 0) continue;
    const evict = events[evictAt]!;
    if (evict.action !== 'evict' || events.slice(evictAt + 1).some((e) => e.action === 'miss')) continue;
    // Which pages were in the pool just before that request: loaded and not yet evicted.
    const resident = new Set<number>();
    for (const e of events.slice(0, evictAt)) {
      if (e.action === 'load') resident.add(e.pageId);
      if (e.action === 'evict') resident.delete(e.victimPageId);
    }
    if (resident.size !== frames) continue;
    const history = refs.slice(0, -1);
    const requested = refs[refs.length - 1]!;
    if (evict.pageId !== requested) continue;

    const before = events.slice(0, evictAt);
    const sweeps = before.slice(lastIndex(before, (e) => e.action === 'miss') + 1);
    const passed = sweeps.flatMap((e) =>
      e.action === 'sweep' ? [`frame ${String(e.frameId)} (down to ${String(e.usageCountAfter)})`] : [],
    );
    const labels = [...resident].sort((a, b) => a - b).map((p) => `page ${String(p)}`);
    const opts = options(labels);
    return {
      id: `clock-victim:${String(seed)}`,
      skill: 'clock-victim',
      seed,
      prompt: [
        `A buffer pool has ${String(frames)} frames, empty at the start, and runs clock sweep: each frame has a usage count that goes up by one every time its page is requested (to at most 5). To evict, the hand moves round the frames, takes one off every non-zero count it passes, and evicts the first frame whose count is already 0. The hand starts at frame 0 and stays where it stopped. The pages are requested in this order:`,
        history.join(', '),
        `Then page ${String(requested)} is requested, and it is not in the pool. The pool is full.`,
        'Which page does the clock sweep evict to make room?',
      ].join('\n'),
      options: opts,
      answer: idOf(opts, `page ${String(evict.victimPageId)}`),
      explanation: [
        passed.length > 0
          ? `The hand passed ${passed.join(', ')}, taking one off each count.`
          : 'The hand was already on a frame whose count was 0.',
        `It stopped at frame ${String(evict.frameId)}, whose count was already 0, so page ${String(evict.victimPageId)} goes.`,
        'Recency does not decide it — only the counts, and where the hand was.',
      ].join(' '),
      link: {
        to: `/tools/buffer-pool?ref=${encodeURIComponent(refs.join(' '))}&frames=${String(frames)}&policy=clock`,
        label: 'Replay this under clock sweep',
      },
    };
  }
}

// ── B+Tree split ──────────────────────────────────────────────────────────────────────────────────────────────────

function nodeKeys(n: BTreeNode): number[] {
  return n.keys.filter((k): k is number => typeof k === 'number');
}

function splitSeparator(seed: number): Question {
  for (let attempt = 0; ; attempt += 1) {
    const r = rng(seed + attempt * 104729);
    const maxKeys = int(r, 3, 4);
    const pool = shuffle(r, Array.from({ length: 60 }, (_, i) => i + 1));
    const have = pool.slice(0, int(r, maxKeys + 1, maxKeys + 4));
    const tree = createTree(maxKeys);
    for (const k of have) insert(tree, k, { pageId: 0, slot: 0 });
    const beforeIds = new Set(Object.keys(tree.nodes));
    // A key whose insertion splits a leaf, and only a leaf: the root must not be the thing that splits.
    for (const k of pool.slice(have.length, have.length + 20)) {
      const probe = structuredClone(tree);
      insert(probe, k, { pageId: 0, slot: 0 });
      const fresh = Object.values(probe.nodes).filter((n) => !beforeIds.has(n.id));
      const leaves = fresh.filter((n) => n.kind === 'leaf');
      if (leaves.length !== 1 || fresh.length !== 1) continue;
      const right = leaves[0]!;
      const separator = nodeKeys(right)[0]!;
      // Not the study's own configuration.
      const left = Object.values(probe.nodes).find((n) => n.kind === 'leaf' && n.next === right.id);
      if (!left) continue;
      const all = [...nodeKeys(left), ...nodeKeys(right)].sort((a, b) => a - b);
      if (all.length < 3) continue;
      const full = [...nodeKeys(left), ...nodeKeys(right)].filter((x) => x !== k).sort((a, b) => a - b);
      const opts = options(all.map((x) => String(x)));
      const leftAfter = nodeKeys(left);
      const rightAfter = nodeKeys(right);
      return {
        id: `split-separator:${String(seed)}`,
        skill: 'split-separator',
        seed,
        prompt: [
          `A B+Tree holds at most ${String(maxKeys)} keys in a node. One of its leaves holds, in order:`,
          full.join(', '),
          `Key ${String(k)} is inserted, and the leaf has to split.`,
          'Which key is copied up into the parent as the separator?',
        ].join('\n'),
        options: opts,
        answer: idOf(opts, String(separator)),
        explanation: `The ${String(all.length)} keys split into [${leftAfter.join(', ')}] and [${rightAfter.join(', ')}]. A leaf split copies the smallest key of the new right leaf up, so ${String(separator)} is now both the separator in the parent and the first key of the right leaf: copied, not moved.`,
        link: {
          to: `/tools/btree?keys=${[...have, k].join(',')}&fanout=${String(maxKeys)}`,
          label: 'Build this tree in the B+Tree sandbox',
        },
      };
    }
  }
}

// ── access path ───────────────────────────────────────────────────────────────────────────────────────────────────

const SCAN_OPS = new Set(['SeqScan', 'IndexScan', 'IndexRangeScan', 'IndexOnlyScan']);

function scanNode(plan: PlanNode | null): PlanNode | null {
  if (!plan) return null;
  if (SCAN_OPS.has(plan.op)) return plan;
  for (const c of plan.children ?? []) {
    const found = scanNode(c);
    if (found) return found;
  }
  return null;
}

const ACCESS_LABELS: Record<string, string> = {
  SeqScan: 'A sequential scan of every page',
  IndexScan: 'An index lookup on id',
  IndexRangeScan: 'An index range scan on id',
  IndexOnlyScan: 'An index-only scan on id',
};

function accessPath(seed: number): Question {
  const db = createSeedDatabase();
  for (let attempt = 0; ; attempt += 1) {
    const r = rng(seed + attempt * 15485863);
    const templates = [
      () => `SELECT * FROM users WHERE id = ${String(int(r, 1, 48))}`,
      () => `SELECT * FROM users WHERE id > ${String(int(r, 2, 46))}`,
      () => `SELECT * FROM users WHERE id < ${String(int(r, 3, 46))}`,
      () => `SELECT * FROM users WHERE id BETWEEN ${String(int(r, 1, 20))} AND ${String(int(r, 21, 48))}`,
      () => `SELECT * FROM users WHERE age > ${String(int(r, 21, 70))}`,
      () => `SELECT * FROM users WHERE name = '${pick(r, ['ada', 'grace', 'ken', 'linus', 'knuth'])}'`,
      () => `SELECT id FROM users WHERE id BETWEEN ${String(int(r, 1, 30))} AND ${String(int(r, 31, 48))}`,
    ];
    const sql = pick(r, templates)();
    const result = runQuery(sql, db);
    const node = scanNode(finalPlan(result.events));
    if (result.error || !node) continue;
    const label = ACCESS_LABELS[node.op];
    if (!label) continue;
    const labels = ['A sequential scan of every page', 'An index lookup on id', 'An index range scan on id'];
    if (!labels.includes(label)) labels.push(label);
    const opts = options(labels);
    const rows = db.tables.users!.rows.length;
    return {
      id: `access-path:${String(seed)}`,
      skill: 'access-path',
      seed,
      prompt: [
        `A table users has ${String(rows)} rows, spread over 12 pages, with a B+Tree index on id and no other index.`,
        sql,
        'Which access path does the planner choose?',
      ].join('\n'),
      options: opts,
      answer: idOf(opts, label),
      explanation: `The planner picked ${node.label} (${node.detail}); it estimated ${String(node.estRows)} row${node.estRows === 1 ? '' : 's'} (${node.estBasis ?? 'no estimate'}). An index helps only a predicate on the indexed column, and only while it is selective enough that following the index costs fewer pages than reading the table.`,
      link: { to: `/playground?q=${encodeURIComponent(sql)}`, label: 'Run it in the Playground' },
    };
  }
}

// ── visibility ────────────────────────────────────────────────────────────────────────────────────────────────────

function visibility(seed: number): Question {
  for (let attempt = 0; ; attempt += 1) {
    const r = rng(seed + attempt * 32452843);
    const xmin = int(r, 1, 5);
    const removed = r() < 0.6;
    const xmax = removed ? int(r, xmin + 1, 6) : null;
    const self = int(r, 1, 6);
    const committed = new Set<number>();
    for (let x = 1; x <= 6; x += 1) if (x !== self && r() < 0.55) committed.add(x);
    const version: Version = { rid: 0, table: 'accounts', row: { id: 1, balance: 100 }, xmin, xmax, order: 0 };
    const visible = isVisible(version, committed, self);
    // Keep the answers balanced over seeds, so "yes" is not the safe guess.
    if (visible !== (seed % 2 === 0)) continue;
    const opts = options(['Yes, it sees it', 'No, it does not']);
    const list = [...committed].sort((a, b) => a - b);
    const why = explainVisibility(version, committed, self);
    return {
      id: `visibility:${String(seed)}`,
      skill: 'visibility',
      seed,
      prompt: [
        'Under snapshot isolation, a row version was created by transaction ' +
          `${String(xmin)} and ${xmax === null ? 'has not been deleted or replaced' : `was deleted or replaced by transaction ${String(xmax)}`}.`,
        `A statement runs as transaction ${String(self)}. Its snapshot counts ${list.length === 0 ? 'no other transaction' : `transactions ${list.join(', ')}`} as committed.`,
        'A version is visible to a statement when the transaction that created it is the statement’s own or is counted as committed, and the transaction that deleted or replaced it, if any, is neither.',
        'Does the statement see this version?',
      ].join('\n'),
      options: opts,
      answer: idOf(opts, visible ? 'Yes, it sees it' : 'No, it does not'),
      explanation: `${why.created} ${why.removed} ${visible ? 'Created, and not removed: it is visible.' : 'So it is not visible.'}`,
      link: { to: '/tools/schedule', label: 'Open the schedule tool' },
    };
  }
}

// ── recovery ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface RecoveryCase {
  steps: WalStep[];
  redone: number;
  skipped: number;
  losers: string[];
  link: string;
}

function recoveryCase(seed: number): RecoveryCase {
  for (let attempt = 0; ; attempt += 1) {
    const r = rng(seed + attempt * 49979687);
    const keys = shuffle(r, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const steps: WalStep[] = [{ op: 'begin', txn: 'T1' }, { op: 'begin', txn: 'T2' }];
    const changes = int(r, 3, 5);
    for (let i = 0; i < changes; i += 1) {
      steps.push({ op: 'set', txn: i % 2 === 0 ? 'T1' : 'T2', key: keys[i]!, value: int(r, 100, 199) });
    }
    if (r() < 0.6) steps.push({ op: 'commit', txn: 'T1' });
    for (const page of shuffle(r, [1, 2, 3, 4]).slice(0, int(r, 1, 2))) steps.push({ op: 'write-page', page });
    steps.push({ op: 'flush-log' }, { op: 'crash' }, { op: 'recover' });
    const run = runWal(steps, { frames: 4 });
    const report = run.steps.at(-1)?.recovery;
    if (!report || run.steps.some((s) => s.error !== undefined)) continue;
    const redone = report.redo.filter((x) => x.action === 'redo').length;
    if (report.redo.length === 0) continue;
    return {
      steps,
      redone,
      skipped: report.redo.length - redone,
      losers: [...report.analysis.losers].sort(),
      link: `/tools/recovery?s=${encodeURIComponent(encodeWalSteps(steps))}`,
    };
  }
}

const scriptLines = (steps: readonly WalStep[]): string[] => steps.map((s, i) => `${String(i + 1)}. ${formatWalStep(s)}`);

function redoCount(seed: number): Question {
  const c = recoveryCase(seed);
  const total = c.redone + c.skipped;
  const labels = shuffle(rng(seed), [...new Set([c.redone, Math.max(0, c.redone - 1), c.redone + 1, total + 1, 0])])
    .slice(0, 4)
    .map(String);
  if (!labels.includes(String(c.redone))) labels[0] = String(c.redone);
  const opts = options([...new Set(labels)].sort((a, b) => Number(a) - Number(b)));
  return {
    id: `redo-count:${String(seed)}`,
    skill: 'redo-count',
    seed,
    prompt: [
      'A write-ahead-logged database, with a pool of four frames, runs this script. The log numbers its records 1, 2, 3 … in the order they are written, and each page records the number of the last change applied to it (its pageLSN).',
      ...scriptLines(c.steps.slice(0, -2)),
      'The machine then restarts, and recovery runs. Redo goes through the log changes that analysis says might be missing from disk.',
      'How many changes does redo actually re-apply, as opposed to skip because the page on disk already has them?',
    ].join('\n'),
    options: opts,
    answer: idOf(opts, String(c.redone)),
    explanation: `Redo looked at ${String(total)} change${total === 1 ? '' : 's'} and re-applied ${String(c.redone)}. It skips a change whose page already carries it — a page written to disk has a pageLSN at or beyond that change's LSN — and re-applies the rest, whoever made them, committed or not: undo comes after.`,
    link: { to: c.link, label: 'Run it in the recovery tool' },
  };
}

function losers(seed: number): Question {
  const c = recoveryCase(seed + 1_000_003);
  const opts = options(['Only T1', 'Only T2', 'Both T1 and T2', 'Neither']);
  const label = c.losers.length === 2 ? 'Both T1 and T2' : c.losers[0] === 'T1' ? 'Only T1' : c.losers[0] === 'T2' ? 'Only T2' : 'Neither';
  return {
    id: `losers:${String(seed)}`,
    skill: 'losers',
    seed,
    prompt: [
      'A write-ahead-logged database runs this script and then the machine stops.',
      ...scriptLines(c.steps.slice(0, -2)),
      'After the restart, analysis reads the log. Which transactions does it name as losers, to be rolled back by undo?',
    ].join('\n'),
    options: opts,
    answer: idOf(opts, label),
    explanation:
      c.losers.length === 0
        ? 'A loser is a transaction with changes in the log and no commit record. Every transaction that wrote anything committed (or wrote nothing durable), so there is nothing for undo to do.'
        : `A loser is a transaction with changes in the durable log and no commit record. ${c.losers.join(' and ')} ${c.losers.length === 1 ? 'has' : 'have'} no commit record, so undo rolls ${c.losers.length === 1 ? 'it' : 'them'} back — however many of ${c.losers.length === 1 ? 'its' : 'their'} pages reached disk.`,
    link: { to: c.link, label: 'Run it in the recovery tool' },
  };
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export function generate(skill: SkillId, seed: number): Question {
  switch (skill) {
    case 'clock-victim':
      return clockVictim(seed);
    case 'split-separator':
      return splitSeparator(seed);
    case 'access-path':
      return accessPath(seed);
    case 'visibility':
      return visibility(seed);
    case 'redo-count':
      return redoCount(seed);
    case 'losers':
      return losers(seed);
  }
}
