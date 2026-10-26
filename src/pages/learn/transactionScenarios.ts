/**
 * The schedules and scripts the transaction and durability lessons hand to a tool. Plain data and a link builder, with
 * no engine import: `/learn/:id` should not carry the schedule runner or the write-ahead-log machine just to build a
 * URL. The discipline the Playground lessons have — a link is only as good as the run behind it — is kept in the
 * tests instead: `__tests__/transactionLessons.test.ts` runs every scenario here on the real engine and asserts the
 * thing the lesson says about it, and fails if a scenario is not used by a lesson or a lesson's link is not a scenario.
 *
 * The URL schemes are the tools' own (`ui/scheduleUrl.ts`, `ui/walUrl.ts`); the tests decode every link with the real
 * decoders, so a change to either shows up there rather than as a link that opens an empty tool.
 */

import type { ProtocolId } from '../../engine/concurrencyCompare.ts';
import type { IsolationLevel } from '../../engine/transactionControl.ts';

export type ScheduleLine = readonly ['A' | 'B', string];
export type LockingMode = 'none' | 'page' | 'row' | 'mvcc';

export interface ScheduleScenario {
  tool: 'schedule';
  lines: readonly ScheduleLine[];
  locking: LockingMode;
  /** Row-level locks only look like row-level locks on the 20-row table, where a statement uses the index. */
  rows: 3 | 20;
  isolation?: IsolationLevel;
}

export interface ConcurrencyScenario {
  tool: 'concurrency';
  lines: readonly ScheduleLine[];
  rows: 3 | 20;
  /** The protocol whose run is opened in detail. */
  protocol?: ProtocolId;
}

export interface WalScenario {
  tool: 'wal' | 'recovery';
  lines: readonly string[];
  frames?: 2 | 3 | 4;
  enforce?: boolean;
  steal?: boolean;
  force?: boolean;
}

export interface IsolationScenario {
  tool: 'isolation';
  /** `engine.test.level`, as the tool writes it in its own URL; none opens the matrix on its default cell. */
  cell?: string;
}

export type Scenario = ScheduleScenario | ConcurrencyScenario | WalScenario | IsolationScenario;

const A = 'A' as const;
const B = 'B' as const;

export const SCENARIOS = {
  // — Let a dirty read happen, then stop it —
  dirtyRead: {
    tool: 'schedule',
    locking: 'none',
    rows: 3,
    lines: [
      [A, 'BEGIN'],
      [A, 'UPDATE accounts SET balance = 0 WHERE id = 1'],
      [B, 'SELECT balance FROM accounts WHERE id = 1'],
      [A, 'ROLLBACK'],
      [B, 'SELECT balance FROM accounts WHERE id = 1'],
    ],
  },
  dirtyReadLocked: {
    tool: 'schedule',
    locking: 'row',
    rows: 20,
    isolation: 'repeatable-read',
    lines: [
      [A, 'BEGIN'],
      [A, 'UPDATE accounts SET balance = 0 WHERE id = 1'],
      [B, 'SELECT balance FROM accounts WHERE id = 1'],
      [A, 'ROLLBACK'],
      [B, 'SELECT balance FROM accounts WHERE id = 1'],
    ],
  },
  deadlock: {
    tool: 'schedule',
    locking: 'row',
    rows: 20,
    lines: [
      [A, 'BEGIN'],
      [B, 'BEGIN'],
      [A, 'UPDATE accounts SET balance = 1 WHERE id = 1'],
      [B, 'UPDATE accounts SET balance = 2 WHERE id = 2'],
      [A, 'UPDATE accounts SET balance = 3 WHERE id = 2'],
      [B, 'UPDATE accounts SET balance = 4 WHERE id = 1'],
      [A, 'COMMIT'],
      [B, 'COMMIT'],
    ],
  },

  // — Read the isolation matrix —
  matrix: { tool: 'isolation' },
  nonRepeatableRead: {
    tool: 'schedule',
    locking: 'row',
    rows: 20,
    isolation: 'read-committed',
    lines: [
      [A, 'BEGIN'],
      [A, 'SELECT balance FROM accounts WHERE id = 1'],
      [B, 'UPDATE accounts SET balance = 50 WHERE id = 1'],
      [A, 'SELECT balance FROM accounts WHERE id = 1'],
      [A, 'COMMIT'],
    ],
  },
  nonRepeatableReadHeld: {
    tool: 'schedule',
    locking: 'row',
    rows: 20,
    isolation: 'repeatable-read',
    lines: [
      [A, 'BEGIN'],
      [A, 'SELECT balance FROM accounts WHERE id = 1'],
      [B, 'UPDATE accounts SET balance = 50 WHERE id = 1'],
      [A, 'SELECT balance FROM accounts WHERE id = 1'],
      [A, 'COMMIT'],
    ],
  },
  phantom: {
    tool: 'schedule',
    locking: 'row',
    rows: 20,
    isolation: 'repeatable-read',
    lines: [
      [A, 'BEGIN'],
      [A, 'SELECT * FROM accounts WHERE balance > 50'],
      [B, "INSERT INTO accounts VALUES (30, 'zed', 100)"],
      [A, 'SELECT * FROM accounts WHERE balance > 50'],
      [A, 'COMMIT'],
    ],
  },
  phantomSerializable: {
    tool: 'schedule',
    locking: 'row',
    rows: 20,
    isolation: 'serializable',
    lines: [
      [A, 'BEGIN'],
      [A, 'SELECT * FROM accounts WHERE balance > 50'],
      [B, "INSERT INTO accounts VALUES (30, 'zed', 100)"],
      [A, 'SELECT * FROM accounts WHERE balance > 50'],
      [A, 'COMMIT'],
    ],
  },

  // — Readers that never wait —
  snapshotRead: {
    tool: 'schedule',
    locking: 'mvcc',
    rows: 20,
    isolation: 'repeatable-read',
    lines: [
      [A, 'BEGIN'],
      [A, 'SELECT balance FROM accounts WHERE id = 1'],
      [B, 'UPDATE accounts SET balance = 50 WHERE id = 1'],
      [A, 'SELECT balance FROM accounts WHERE id = 1'],
      [A, 'COMMIT'],
    ],
  },
  firstCommitterWins: {
    tool: 'schedule',
    locking: 'mvcc',
    rows: 20,
    isolation: 'repeatable-read',
    lines: [
      [A, 'BEGIN'],
      [A, 'SELECT balance FROM accounts WHERE id = 1'],
      [B, 'BEGIN'],
      [B, 'UPDATE accounts SET balance = 150 WHERE id = 1'],
      [B, 'COMMIT'],
      [A, 'UPDATE accounts SET balance = 120 WHERE id = 1'],
      [A, 'COMMIT'],
    ],
  },
  writeSkew: {
    tool: 'schedule',
    locking: 'mvcc',
    rows: 20,
    isolation: 'repeatable-read',
    lines: [
      [A, 'BEGIN'],
      [B, 'BEGIN'],
      [A, 'SELECT * FROM accounts WHERE id <= 2'],
      [B, 'SELECT * FROM accounts WHERE id <= 2'],
      [A, 'UPDATE accounts SET balance = 0 WHERE id = 1'],
      [B, 'UPDATE accounts SET balance = 0 WHERE id = 2'],
      [A, 'COMMIT'],
      [B, 'COMMIT'],
    ],
  },
  deadTuples: {
    tool: 'schedule',
    locking: 'mvcc',
    rows: 20,
    isolation: 'read-committed',
    lines: [
      [A, 'UPDATE accounts SET balance = 1 WHERE id = 1'],
      [A, 'UPDATE accounts SET balance = 2 WHERE id = 1'],
      [A, 'UPDATE accounts SET balance = 3 WHERE id = 1'],
      [B, 'BEGIN'],
      [B, 'UPDATE accounts SET balance = 0 WHERE id = 2'],
      [B, 'ROLLBACK'],
    ],
  },

  // — Locks, timestamps or optimism? —
  protocolsLostUpdate: {
    tool: 'concurrency',
    rows: 20,
    lines: [
      [A, 'BEGIN'],
      [A, 'SELECT balance FROM accounts WHERE id = 1'],
      [B, 'UPDATE accounts SET balance = 150 WHERE id = 1'],
      [A, 'UPDATE accounts SET balance = 120 WHERE id = 1'],
      [A, 'COMMIT'],
    ],
  },
  protocolsWriteSkew: {
    tool: 'concurrency',
    rows: 20,
    protocol: 'snapshot',
    lines: [
      [A, 'BEGIN'],
      [B, 'BEGIN'],
      [A, 'SELECT * FROM accounts WHERE id <= 2'],
      [B, 'SELECT * FROM accounts WHERE id <= 2'],
      [A, 'UPDATE accounts SET balance = 0 WHERE id = 1'],
      [B, 'UPDATE accounts SET balance = 0 WHERE id = 2'],
      [A, 'COMMIT'],
      [B, 'COMMIT'],
    ],
  },
  protocolsNonRepeatable: {
    tool: 'concurrency',
    rows: 20,
    protocol: 'snapshot',
    lines: [
      [A, 'BEGIN'],
      [A, 'SELECT balance FROM accounts WHERE id = 1'],
      [B, 'UPDATE accounts SET balance = 50 WHERE id = 1'],
      [A, 'SELECT balance FROM accounts WHERE id = 1'],
      [A, 'COMMIT'],
    ],
  },

  // — Why the log goes first —
  ruleEnforced: {
    tool: 'wal',
    frames: 3,
    enforce: true,
    lines: ['begin T1', 'set T1 a = 99', 'write page 1'],
  },
  ruleOff: {
    tool: 'recovery',
    frames: 3,
    enforce: false,
    lines: ['begin T1', 'set T1 a = 99', 'write page 1', 'crash', 'recover'],
  },
  commitIsALogWrite: {
    tool: 'wal',
    frames: 3,
    enforce: true,
    lines: ['begin T1', 'set T1 a = 99', 'commit T1'],
  },

  // — Steal and force —
  noForce: {
    tool: 'wal',
    frames: 4,
    enforce: true,
    steal: true,
    force: false,
    lines: ['begin T1', 'set T1 a = 1', 'set T1 c = 2', 'set T1 e = 3', 'commit T1'],
  },
  force: {
    tool: 'wal',
    frames: 4,
    enforce: true,
    steal: true,
    force: true,
    lines: ['begin T1', 'set T1 a = 1', 'set T1 c = 2', 'set T1 e = 3', 'commit T1'],
  },
  steal: {
    tool: 'wal',
    frames: 2,
    enforce: true,
    steal: true,
    force: false,
    lines: ['begin T1', 'set T1 a = 1', 'read page 2', 'read page 3'],
  },
  noSteal: {
    tool: 'wal',
    frames: 2,
    enforce: true,
    steal: false,
    force: false,
    lines: ['begin T1', 'set T1 a = 1', 'set T1 c = 2', 'read page 3'],
  },

  // — Survive a crash —
  bothAtOnce: {
    tool: 'recovery',
    frames: 3,
    enforce: true,
    lines: [
      'begin T1',
      'begin T2',
      'set T1 a = 1',
      'set T2 c = 2',
      'set T2 g = 3',
      'commit T1',
      'write page 2',
      'crash',
      'recover',
    ],
  },
  checkpoint: {
    tool: 'recovery',
    frames: 3,
    enforce: true,
    lines: [
      'begin T1',
      'set T1 a = 1',
      'set T1 c = 2',
      'commit T1',
      'write page 1',
      'write page 2',
      'checkpoint',
      'begin T2',
      'set T2 e = 9',
      'flush log',
      'crash',
      'recover',
    ],
  },
  crashDuringRecovery: {
    tool: 'recovery',
    frames: 4,
    enforce: true,
    lines: [
      'begin T1',
      'set T1 a = 1',
      'set T1 c = 2',
      'set T1 e = 3',
      'write page 1',
      'write page 2',
      'write page 3',
      'crash',
      'recover, crash after 2',
      'recover',
    ],
  },
} as const satisfies Record<string, Scenario>;

export type ScenarioName = keyof typeof SCENARIOS;

/** `/tools/…?…` for a scenario, in the URL scheme the tool itself writes. */
export function scenarioHref(scenario: Scenario): string {
  const params = new URLSearchParams();
  switch (scenario.tool) {
    case 'isolation':
      if (scenario.cell !== undefined) params.set('c', scenario.cell);
      break;
    case 'schedule':
      params.set('s', JSON.stringify(scenario.lines));
      if (scenario.locking !== 'none') params.set('l', scenario.locking);
      params.set('n', String(scenario.rows));
      if (scenario.isolation !== undefined) params.set('i', scenario.isolation);
      break;
    case 'concurrency':
      params.set('s', JSON.stringify(scenario.lines));
      params.set('n', String(scenario.rows));
      if (scenario.protocol !== undefined) params.set('p', scenario.protocol);
      break;
    case 'wal':
    case 'recovery':
      params.set('s', JSON.stringify(scenario.lines));
      if (scenario.frames !== undefined && scenario.frames !== 3) params.set('f', String(scenario.frames));
      if (scenario.enforce === false) params.set('e', '0');
      if (scenario.steal === false) params.set('st', '0');
      if (scenario.force === true) params.set('fo', '1');
      break;
  }
  const query = params.toString();
  return `/tools/${scenario.tool}${query ? `?${query}` : ''}`;
}
