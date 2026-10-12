import { describe, expect, it } from 'vitest';
import { decodeSchedule } from '../../../ui/scheduleUrl.ts';
import { decodeWalSteps } from '../../../ui/walUrl.ts';
import { CHALLENGES } from '../challenges.tsx';
import { SCRIPT_CHALLENGES, scriptChallengeById } from '../scriptChallenges.tsx';
import { CHECKED, parseSchedule, parseWal, runScript } from '../scriptRunner.ts';

const lines = (...l: string[]) => l.join('\n');
const challenge = (id: string) => scriptChallengeById(id)!;
const passes = (id: string, script: string) => runScript(challenge(id), script).passed;

describe('script challenges', () => {
  it('have ids that are unique across every challenge, and each has a check of its own kind', () => {
    const ids = [...CHALLENGES, ...SCRIPT_CHALLENGES].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of SCRIPT_CHALLENGES) {
      expect(CHECKED[c.setup.kind], `${c.id} has no ${c.setup.kind} check`).toContain(c.id);
    }
    expect(Object.values(CHECKED).flat().sort()).toEqual(SCRIPT_CHALLENGES.map((c) => c.id).sort());
  });

  it('start from a script that runs and does not pass', () => {
    for (const c of SCRIPT_CHALLENGES) {
      const r = runScript(c, c.starter);
      expect(r.problem, `${c.id} starter does not run: ${r.problem ?? ''}`).toBeNull();
      expect(r.passed, `${c.id} starter should not pass`).toBe(false);
    }
  });

  it('look up by id', () => {
    for (const c of SCRIPT_CHALLENGES) expect(scriptChallengeById(c.id)).toBe(c);
    expect(scriptChallengeById('use-the-index')).toBeUndefined();
    expect(scriptChallengeById(undefined)).toBeUndefined();
  });

  // One known solution each — the check must accept it.
  const solutions: Record<string, string> = {
    'read-the-unreal': lines(
      'A: BEGIN',
      'A: UPDATE accounts SET balance = 0 WHERE id = 1',
      'B: SELECT balance FROM accounts WHERE id = 1',
      'A: ROLLBACK',
    ),
    'make-it-wait': lines(
      'A: BEGIN',
      'A: UPDATE accounts SET balance = 0 WHERE id = 1',
      'B: SELECT balance FROM accounts WHERE id = 1',
      'A: COMMIT',
    ),
    'pick-the-victim': lines(
      'A: BEGIN',
      'B: BEGIN',
      'B: UPDATE accounts SET balance = 2 WHERE id = 2',
      'A: UPDATE accounts SET balance = 1 WHERE id = 1',
      'A: UPDATE accounts SET balance = 3 WHERE id = 2',
      'B: UPDATE accounts SET balance = 4 WHERE id = 1',
      'A: COMMIT',
      'B: COMMIT',
    ),
    'lose-an-update': lines(
      'A: BEGIN',
      'A: SELECT balance FROM accounts WHERE id = 1',
      'B: UPDATE accounts SET balance = 150 WHERE id = 1',
      'A: UPDATE accounts SET balance = 120 WHERE id = 1',
      'A: COMMIT',
    ),
    'read-past-the-writer': lines(
      'A: BEGIN',
      'A: UPDATE accounts SET balance = 0 WHERE id = 1',
      'B: SELECT balance FROM accounts WHERE id = 1',
      'A: COMMIT',
    ),
    'write-skew': lines(
      'A: BEGIN',
      'B: BEGIN',
      'A: SELECT * FROM accounts WHERE id <= 2',
      'B: SELECT * FROM accounts WHERE id <= 2',
      'A: UPDATE accounts SET balance = 0 WHERE id = 1',
      'B: UPDATE accounts SET balance = 0 WHERE id = 2',
      'A: COMMIT',
      'B: COMMIT',
    ),
    'aborted-by-the-clock': lines(
      'A: BEGIN',
      'A: SELECT balance FROM accounts WHERE id = 1',
      'B: UPDATE accounts SET balance = 150 WHERE id = 1',
      'A: UPDATE accounts SET balance = 120 WHERE id = 1',
      'A: COMMIT',
    ),
    'ahead-of-its-log': lines('begin T1', 'set T1 a = 99', 'write page 1', 'crash', 'recover'),
    'redo-a-commit': lines('begin T1', 'set T1 a = 99', 'commit T1', 'crash', 'recover'),
    'undo-a-steal': lines('begin T1', 'set T1 a = 99', 'write page 1', 'crash', 'recover'),
    'crash-in-recovery': lines(
      'begin T1',
      'set T1 a = 99',
      'set T1 c = 5',
      'write page 1',
      'write page 2',
      'crash',
      'recover, crash after 1',
      'recover',
    ),
    'start-redo-late': lines(
      'begin T1',
      'set T1 a = 99',
      'commit T1',
      'write page 1',
      'checkpoint',
      'begin T2',
      'set T2 c = 5',
      'commit T2',
      'crash',
      'recover',
    ),
    'no-steal-needs-a-pool': lines('begin T1', 'set T1 a = 1', 'set T1 c = 2', 'set T1 e = 3'),
  };

  it('has a solution wired for every challenge', () => {
    expect(Object.keys(solutions).sort()).toEqual(SCRIPT_CHALLENGES.map((c) => c.id).sort());
  });

  it('accepts a known solution, and hands over a link to the tool that decodes to what was written', () => {
    for (const c of SCRIPT_CHALLENGES) {
      const script = solutions[c.id]!;
      const r = runScript(c, script);
      expect(r.problem, c.id).toBeNull();
      expect(r.passed, `${c.id} rejected its solution`).toBe(true);
      expect(r.tables.length, c.id).toBeGreaterThan(0);
      const url = new URL(r.toolHref!, 'https://x');
      expect(url.pathname.startsWith('/tools/'), c.id).toBe(true);
      if (c.setup.kind === 'wal') {
        expect(decodeWalSteps(url.searchParams.get('s')), c.id).toEqual(parseWal(script).steps);
      } else {
        expect(decodeSchedule(url.searchParams.get('s')), c.id).toEqual(parseSchedule(script).steps);
      }
    }
  });

  describe('reject the near-misses', () => {
    const cheats: [string, string, string][] = [
      [
        'read-the-unreal',
        'a dirty read that A then commits',
        lines('A: BEGIN', 'A: UPDATE accounts SET balance = 0 WHERE id = 1', 'B: SELECT balance FROM accounts WHERE id = 1', 'A: COMMIT'),
      ],
      [
        'read-the-unreal',
        'a rollback before B reads',
        lines('A: BEGIN', 'A: UPDATE accounts SET balance = 0 WHERE id = 1', 'A: ROLLBACK', 'B: SELECT balance FROM accounts WHERE id = 1'),
      ],
      [
        'read-the-unreal',
        'a dirty read of a transaction that commits, after one that rolled back',
        lines(
          'A: BEGIN',
          'A: UPDATE accounts SET balance = 5 WHERE id = 3',
          'A: ROLLBACK',
          'A: BEGIN',
          'A: UPDATE accounts SET balance = 0 WHERE id = 1',
          'B: SELECT balance FROM accounts WHERE id = 1',
          'A: COMMIT',
        ),
      ],
      [
        'make-it-wait',
        'a wait that never ends',
        lines('A: BEGIN', 'A: UPDATE accounts SET balance = 0 WHERE id = 1', 'B: SELECT balance FROM accounts WHERE id = 1'),
      ],
      [
        'make-it-wait',
        'a wait that ends in a deadlock',
        lines(
          'A: BEGIN',
          'B: BEGIN',
          'A: UPDATE accounts SET balance = 1 WHERE id = 1',
          'B: UPDATE accounts SET balance = 2 WHERE id = 2',
          'A: UPDATE accounts SET balance = 3 WHERE id = 2',
          'B: UPDATE accounts SET balance = 4 WHERE id = 1',
          'A: COMMIT',
          'B: COMMIT',
        ),
      ],
      [
        'make-it-wait',
        'one wait that ends, and a second that never does',
        lines(
          'A: BEGIN',
          'A: UPDATE accounts SET balance = 0 WHERE id = 1',
          'B: SELECT balance FROM accounts WHERE id = 1',
          'A: COMMIT',
          'A: BEGIN',
          'A: UPDATE accounts SET balance = 0 WHERE id = 2',
          'B: SELECT balance FROM accounts WHERE id = 2',
        ),
      ],
      [
        'pick-the-victim',
        'a wait with no circle in it',
        lines('A: BEGIN', 'A: UPDATE accounts SET balance = 0 WHERE id = 1', 'B: UPDATE accounts SET balance = 1 WHERE id = 1', 'A: COMMIT'),
      ],
      [
        'lose-an-update',
        'a lost update in a transaction that rolls back',
        lines(
          'A: BEGIN',
          'A: SELECT balance FROM accounts WHERE id = 1',
          'B: UPDATE accounts SET balance = 150 WHERE id = 1',
          'A: UPDATE accounts SET balance = 120 WHERE id = 1',
          'A: ROLLBACK',
        ),
      ],
      [
        'read-past-the-writer',
        'a read of a row nobody has changed',
        lines('A: BEGIN', 'A: UPDATE accounts SET balance = 0 WHERE id = 1', 'B: SELECT balance FROM accounts WHERE id = 2', 'A: COMMIT'),
      ],
      [
        'write-skew',
        'two writers to one row, of which one is refused',
        lines(
          'A: BEGIN',
          'B: BEGIN',
          'A: SELECT balance FROM accounts WHERE id = 1',
          'B: SELECT balance FROM accounts WHERE id = 1',
          'A: UPDATE accounts SET balance = 0 WHERE id = 1',
          'A: COMMIT',
          'B: UPDATE accounts SET balance = 0 WHERE id = 1',
          'B: COMMIT',
        ),
      ],
      [
        'write-skew',
        'two transactions that each read and write only their own row',
        lines(
          'A: BEGIN',
          'B: BEGIN',
          'A: SELECT balance FROM accounts WHERE id = 1',
          'B: SELECT balance FROM accounts WHERE id = 2',
          'A: UPDATE accounts SET balance = 0 WHERE id = 1',
          'B: UPDATE accounts SET balance = 0 WHERE id = 2',
          'A: COMMIT',
          'B: COMMIT',
        ),
      ],
      [
        'aborted-by-the-clock',
        'a schedule locking itself ends in a deadlock',
        lines(
          'A: BEGIN',
          'B: BEGIN',
          'A: UPDATE accounts SET balance = 1 WHERE id = 1',
          'B: UPDATE accounts SET balance = 2 WHERE id = 2',
          'A: UPDATE accounts SET balance = 3 WHERE id = 2',
          'B: UPDATE accounts SET balance = 4 WHERE id = 1',
          'A: COMMIT',
          'B: COMMIT',
        ),
      ],
      [
        'aborted-by-the-clock',
        'a deadlock followed by enough autocommits to look like two commits',
        lines(
          'A: BEGIN',
          'B: BEGIN',
          'A: UPDATE accounts SET balance = 1 WHERE id = 1',
          'B: UPDATE accounts SET balance = 2 WHERE id = 2',
          'A: UPDATE accounts SET balance = 3 WHERE id = 2',
          'B: UPDATE accounts SET balance = 4 WHERE id = 1',
          'A: COMMIT',
          'A: UPDATE accounts SET balance = 9 WHERE id = 5',
          'B: UPDATE accounts SET balance = 9 WHERE id = 6',
        ),
      ],
      ['ahead-of-its-log', 'no crash at all', lines('begin T1', 'set T1 a = 99', 'write page 1')],
      ['ahead-of-its-log', 'a crash and no recovery', lines('begin T1', 'set T1 a = 99', 'write page 1', 'crash')],
      [
        'redo-a-commit',
        'a commit whose page was written before the crash',
        lines('begin T1', 'set T1 a = 99', 'commit T1', 'write page 1', 'crash', 'recover'),
      ],
      [
        'redo-a-commit',
        'a redo of a change that never committed',
        lines('begin T1', 'set T1 a = 99', 'flush log', 'crash', 'recover'),
      ],
      [
        'undo-a-steal',
        'an undo of a change that never reached the disk',
        lines('begin T1', 'set T1 a = 99', 'flush log', 'crash', 'recover'),
      ],
      [
        'undo-a-steal',
        'a change rolled back and its page rewritten before the crash',
        lines('begin T1', 'set T1 a = 99', 'write page 1', 'abort T1', 'write page 1', 'crash', 'recover'),
      ],
      [
        'crash-in-recovery',
        'a crash point after the last undo, so recovery finishes',
        lines('begin T1', 'set T1 a = 99', 'write page 1', 'crash', 'recover, crash after 9'),
      ],
      [
        'crash-in-recovery',
        'an interrupted recovery nobody follows up',
        lines('begin T1', 'set T1 a = 99', 'set T1 c = 5', 'write page 1', 'write page 2', 'crash', 'recover, crash after 1'),
      ],
      [
        'start-redo-late',
        'a checkpoint right at the start, with nothing before it',
        lines('begin T1', 'checkpoint', 'set T1 a = 99', 'commit T1', 'crash', 'recover'),
      ],
      [
        'no-steal-needs-a-pool',
        'a page write the policy refuses',
        lines('begin T1', 'set T1 a = 1', 'write page 1'),
      ],
    ];
    for (const [id, why, script] of cheats) {
      it(`${id} rejects ${why}`, () => {
        const r = runScript(challenge(id), script);
        expect(r.problem).toBeNull();
        expect(r.passed).toBe(false);
      });
    }
  });

  it('tells a lost-update attempt apart from the same schedule under the default level', () => {
    // The challenge fixes READ COMMITTED; the same text at REPEATABLE READ makes B wait and loses nothing.
    expect(passes('lose-an-update', solutions['lose-an-update']!)).toBe(true);
    const held = { ...challenge('lose-an-update'), setup: { kind: 'schedule', locking: 'row', rows: 20, isolation: 'repeatable-read' } as const };
    expect(runScript(held, solutions['lose-an-update']!).passed).toBe(false);
  });
});

describe('parsing what the player wrote', () => {
  it('reads one step to a line, ignoring blanks, comments and trailing semicolons', () => {
    const p = parseSchedule('-- a comment\n\nA: BEGIN;\n  b :  SELECT * FROM accounts ;;\n');
    expect(p.problem).toBeNull();
    expect(p.steps).toEqual([
      { session: 'A', sql: 'BEGIN' },
      { session: 'B', sql: 'SELECT * FROM accounts' },
    ]);
  });

  it('names the line that is not a step', () => {
    expect(parseSchedule('A: BEGIN\nUPDATE accounts SET balance = 0').problem).toMatch(/^Line 2: begin each step with A: or B:/);
    expect(parseSchedule('C: BEGIN').problem).toMatch(/^Line 1:/);
    expect(parseSchedule('A:').problem).toMatch(/^Line 1: there is nothing after “A:”/);
    expect(parseSchedule('A: SELECT ' + 'x'.repeat(500)).problem).toMatch(/at most 400 characters/);
    expect(parseSchedule('   \n').problem).toBe('Write at least one step.');
    expect(parseSchedule(Array.from({ length: 41 }, () => 'A: BEGIN').join('\n')).problem).toMatch(/at most 40 steps/);
  });

  it('reads the log tool’s own words, and names the line that is not one', () => {
    const p = parseWal('begin T1\nset T1 a = 99\nrecover, crash after 1');
    expect(p.problem).toBeNull();
    expect(p.steps).toHaveLength(3);
    expect(parseWal('begin T1\nfrobnicate').problem).toMatch(/^Line 2: “frobnicate” is not a step/);
    expect(parseWal('').problem).toBe('Write at least one step.');
    expect(parseWal(Array.from({ length: 41 }, () => 'flush log').join('\n')).problem).toMatch(/at most 40 steps/);
  });

  it('runs nothing when the text does not parse', () => {
    const r = runScript(challenge('read-the-unreal'), 'hello');
    expect(r.problem).toMatch(/^Line 1/);
    expect(r.passed).toBe(false);
    expect(r.tables).toEqual([]);
    expect(r.toolHref).toBeNull();
  });

  it('reports a statement the engine refuses as a step that failed, not as a problem with the text', () => {
    const r = runScript(challenge('read-the-unreal'), lines('A: BEGIN', 'A: SELEKT 1', 'A: ROLLBACK'));
    expect(r.problem).toBeNull();
    expect(r.passed).toBe(false);
    expect(r.tables[0]!.rows.some((row) => row.join(' ').toLowerCase().includes('select'))).toBe(true);
  });
});
