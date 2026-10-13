import { useState } from 'react';
import { markSolved, readSolved } from '../../ui/challengeProgress.ts';
import { btnPrimary, inputField } from '../../ui/primitives.ts';
import { ChallengeHeader, ChallengeOutcomeView, SolvedPanel } from './ChallengeFrame.tsx';
import type { ChallengeOutcome } from './outcome.ts';
import type { ScriptChallenge, ScriptSetup } from './scriptChallenges.tsx';
import { runScript } from './scriptRunner.ts';

/**
 * One transaction or durability challenge (`scriptChallenges.tsx`): a script in a plain text box, one step to a line,
 * run on the engine and checked. The text box is not a code editor on purpose — the steps are not SQL, and a screen
 * reader and a keyboard both know what a textarea is. The loaded chunk is the schedule runner and the log machine,
 * which is why this view is opened lazily.
 */

const LOCKING_WORDS = {
  none: 'No concurrency control at all.',
  page: 'Page locks, held to the end of the transaction.',
  row: 'Row locks, held to the end of the transaction.',
  mvcc: 'Versions and snapshots: readers take no lock, writers lock the rows they change.',
} as const;

const LEVEL_WORDS = {
  'read-uncommitted': 'READ UNCOMMITTED',
  'read-committed': 'READ COMMITTED',
  'repeatable-read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
} as const;

function Setup({ setup }: { setup: ScriptSetup }) {
  if (setup.kind === 'locks') {
    return (
      <p className="text-label text-ink-dim">
        Two transactions, <strong className="text-ink">T1</strong> and <strong className="text-ink">T2</strong>, and four
        pages, 0 to 3. Each line is a lock request or a release, placed in the order written; a request that conflicts waits,
        and a circle of waits is a deadlock.
      </p>
    );
  }
  if (setup.kind === 'wal') {
    return (
      <p className="text-label text-ink-dim">
        Pages 1–4 hold the cells <code className="font-mono text-ink">a</code>–<code className="font-mono text-ink">h</code>,
        two to a page (a, b on page 1; c, d on page 2; and so on), each starting at 10, 20, 30 … 80. {setup.frames} frames.{' '}
        {setup.enforce ? 'A page waits for its log.' : <strong className="text-ink">The log-before-data rule is off.</strong>}{' '}
        {setup.steal ? 'Steal.' : <strong className="text-ink">No-steal.</strong>} {setup.force ? 'Force.' : 'No-force.'}
      </p>
    );
  }
  const accounts = (
    <>
      Sessions <strong className="text-ink">A</strong> and <strong className="text-ink">B</strong> share{' '}
      <code className="font-mono text-ink">accounts (id, owner, balance)</code> — {setup.rows} rows, every balance 100.
    </>
  );
  if (setup.kind === 'protocols') {
    return (
      <p className="text-label text-ink-dim">
        {accounts} Your schedule is run under each of the five protocols.
      </p>
    );
  }
  return (
    <p className="text-label text-ink-dim">
      {accounts} {LOCKING_WORDS[setup.locking]}
      {setup.locking !== 'none' && (
        <> Isolation: {LEVEL_WORDS[setup.isolation ?? 'repeatable-read']}.</>
      )}
    </p>
  );
}

function Syntax({ setup }: { setup: ScriptSetup }) {
  return (
    <details className="text-label text-ink-dim">
      <summary className="cursor-pointer underline-offset-2 hover:text-ink hover:underline">What goes on a line</summary>
      {setup.kind === 'locks' ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          <li>
            <code className="font-mono text-ink">T1 shared 0</code>, <code className="font-mono text-ink">T2 exclusive 3</code>{' '}
            — ask for a shared or an exclusive lock on a page (<code className="font-mono text-ink">s</code> and{' '}
            <code className="font-mono text-ink">x</code> will do)
          </li>
          <li>
            <code className="font-mono text-ink">T1 release shared 0</code> — let a lock go; a waiter behind it is promoted
          </li>
          <li>The steps run in the order you write them. Blank lines and lines that start with <code className="font-mono text-ink">--</code> are skipped.</li>
        </ul>
      ) : setup.kind === 'wal' ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          <li>
            <code className="font-mono text-ink">begin T1</code>, <code className="font-mono text-ink">commit T1</code>,{' '}
            <code className="font-mono text-ink">abort T1</code> — any transaction name
          </li>
          <li>
            <code className="font-mono text-ink">set T1 a = 99</code> — change a cell, a to h
          </li>
          <li>
            <code className="font-mono text-ink">write page 1</code>, <code className="font-mono text-ink">read page 3</code>,{' '}
            <code className="font-mono text-ink">flush log</code>, <code className="font-mono text-ink">checkpoint</code>
          </li>
          <li>
            <code className="font-mono text-ink">crash</code>, <code className="font-mono text-ink">recover</code>,{' '}
            <code className="font-mono text-ink">recover, crash after 1</code>
          </li>
        </ul>
      ) : (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          <li>
            <code className="font-mono text-ink">A: BEGIN</code>, <code className="font-mono text-ink">B: COMMIT</code>,{' '}
            <code className="font-mono text-ink">A: ROLLBACK</code>
          </li>
          <li>
            <code className="font-mono text-ink">A: UPDATE accounts SET balance = 0 WHERE id = 1</code> — any statement the
            engine runs, after the session&apos;s name
          </li>
          <li>The steps run in the order you write them. Blank lines and lines that start with <code className="font-mono text-ink">--</code> are skipped.</li>
        </ul>
      )}
    </details>
  );
}

export interface ScriptChallengeViewProps {
  challenge: ScriptChallenge;
  /** Zero-based place in the whole list of challenges, and how many there are. */
  index: number;
  total: number;
  next: { id: string; title: string } | null;
}

export function ScriptChallengeView({ challenge, index, total, next }: ScriptChallengeViewProps) {
  const [text, setText] = useState(challenge.starter);
  const [run, setRun] = useState<ChallengeOutcome | null>(null);
  const [solved, setSolved] = useState(() => readSolved().has(challenge.id));

  function check() {
    const next = runScript(challenge, text);
    setRun(next);
    if (next.passed && !solved) {
      markSolved(challenge.id);
      setSolved(true);
    }
  }

  const rows = Math.min(16, Math.max(7, text.split('\n').length + 1));

  return (
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <ChallengeHeader
        index={index}
        total={total}
        title={challenge.title}
        brief={challenge.brief}
        hint={challenge.hint}
      />

      <div className="mt-4 space-y-3">
        <Setup setup={challenge.setup} />
        <label className="flex flex-col gap-1 text-label text-ink-dim">
          {challenge.setup.kind === 'wal' || challenge.setup.kind === 'locks' ? 'Script — one step to a line' : 'Schedule — one step to a line'}
          <textarea
            value={text}
            rows={rows}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => { setText(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                check();
              }
            }}
            className={`${inputField} w-full resize-y font-mono text-body leading-relaxed text-ink`}
          />
        </label>
        <Syntax setup={challenge.setup} />
        <button type="button" onClick={check} className={btnPrimary}>
          Run &amp; check
        </button>
      </div>

      <ChallengeOutcomeView outcome={run} notYet="read what each step did." />

      {solved && <SolvedPanel misconception={challenge.misconception} next={next} />}
    </div>
  );
}
