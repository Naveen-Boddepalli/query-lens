import type { LessonStep } from './lessons.tsx';
import { SANDBOX_SCENARIOS, sandboxHref } from './sandboxScenarios.ts';
import type { SandboxScenarioName } from './sandboxScenarios.ts';

/**
 * The lessons for the oldest sandboxes — the buffer pool, the parser, the grammar, the planner and the lock table —
 * which were built before there were lessons and had only the pipeline's own to stand in for them. A step's link is a
 * scenario in `sandboxScenarios.ts`, and `__tests__/sandboxLessons.test.ts` runs every scenario on the engine the
 * tool runs, against the sentence its lesson says about it.
 */

const code = (text: string) => <code className="font-mono">{text}</code>;
const to = (name: SandboxScenarioName, label: string) => ({
  href: sandboxHref(SANDBOX_SCENARIOS[name]),
  label,
});

export const SANDBOX_STEPS: Record<string, LessonStep[]> = {
  'buffer-pool': [
    {
      heading: 'A loop one page too big',
      body: (
        <>
          A bare string of page numbers, a pool of four frames and least-recently-used eviction. The string loops over
          five pages, one more than the pool holds, so each page is evicted just before it is asked for again: ten
          references, <strong>ten misses</strong>, no hits at all.
        </>
      ),
      link: to('poolLoop', 'Open the loop under LRU'),
    },
    {
      heading: 'What a policy that could see ahead would do',
      body: (
        <>
          Under the <em>optimal</em> policy the same string has <strong>four hits</strong> in ten. It evicts the page
          whose next use is furthest away, which no real pool can know; it is the ceiling the others are measured against.
        </>
      ),
      link: to('poolLoopOptimal', 'Open it under the optimal policy'),
      tryThis: (
        <>
          Try 2Q on the same string: one hit in ten. It does not escape the loop either — and neither does any policy
          that has to guess.
        </>
      ),
    },
    {
      heading: 'More frames, more misses',
      body: (
        <>
          The classic string {code('1 2 3 4 1 2 5 1 2 3 4 5')} under FIFO misses 9 times in three frames and{' '}
          <strong>10</strong> in four: a bigger pool, more misses. LRU, on the same string, goes from 10 misses to 8, as
          it must — it is a policy whose cache with more frames always holds everything the smaller one did.
        </>
      ),
      link: to('poolBelady', 'Open it with three frames'),
      tryThis: (
        <>
          Raise the frames to 4 and read the miss count, then switch the policy to LRU and do it again.
        </>
      ),
    },
    {
      heading: 'A scan sweeps the hot set',
      body: (
        <>
          Four hot pages read three times, then a 21-page scan, then the hot pages again. Under LRU in six frames the scan
          pushes the hot set out, and the pages come back as misses: <strong>12 hits</strong> in 41. LRU-K keeps them
          for 16 — and so does LRU itself, with a scan ring of two frames, because the scan then reads through its own
          frames and leaves the rest alone.
        </>
      ),
      link: to('poolScan', 'Open the scan under LRU'),
      tryThis: (
        <>
          Give the pool a scan ring of 3 and read the hits again. The ring takes frames from the hot set too, once there
          are fewer free ones than the ring is big.
        </>
      ),
    },
  ],

  'tokens-and-trees': [
    {
      heading: 'Text becomes tokens',
      body: (
        <>
          Before there is a tree there is a stream. The query is cut into fifteen tokens — keywords, identifiers, a
          number, an operator, a string — and an end-of-input marker the parser reads to know it has finished. The
          ribbon colours each by what it is.
        </>
      ),
      link: to('parserTokens', 'Open the token ribbon'),
    },
    {
      heading: 'AND binds tighter than OR',
      body: (
        <>
          {code('id = 1 OR id = 2 AND age = 3')} is read as {code('id = 1 OR (id = 2 AND age = 3)')}: the tree has the{' '}
          {code('OR')} at its root and the {code('AND')} one level down, because the parser takes the tighter operator
          first. It is not read left to right.
        </>
      ),
      link: to('parserPrecedence', 'Open it without parentheses'),
      tryThis: (
        <>
          Put parentheses around the {code('OR')} and watch the tree turn over: now the {code('AND')} is the root and
          the {code('OR')} is under it. Same words, a different question.
        </>
      ),
    },
    {
      heading: 'An error has a place',
      body: (
        <>
          {code('SELECT FROM users')} has no column list, and the parser says so where it stopped: it expected a column
          name or a value and found {code('FROM')}, underlined in the source. A parse error is a position and a
          sentence, never a guess about what was meant.
        </>
      ),
      link: to('parserError', 'Open the error'),
      tryThis: (
        <>
          Close a string badly — {code("WHERE name = 'ada")} — and the tokenizer, which runs first, reports it before the
          parser has a chance to.
        </>
      ),
    },
  ],

  'grammar-diagram': [
    {
      heading: 'The order is the diagram’s',
      body: (
        <>
          The {code('select')} rule reads left to right: {code('SELECT')}, an optional {code('DISTINCT')}, the columns,{' '}
          {code('FROM')}, any joins, then optionally {code('WHERE')}, {code('GROUP BY')}, {code('HAVING')},{' '}
          {code('ORDER BY')} and {code('LIMIT')} with an {code('OFFSET')}. A dashed bracket is optional, and the order
          inside it is fixed: a {code('WHERE')} after an {code('ORDER BY')} is refused, naming the clause that arrived late.
        </>
      ),
      link: to('grammarSelect', 'Open the select rule'),
    },
    {
      heading: 'Precedence is layers of rules',
      body: (
        <>
          An expression is an {code('orExpr')}, made of {code('andExpr')}s joined by {code('OR')}, each made of{' '}
          {code('notExpr')}s joined by {code('AND')}. The loosest-binding operator is the outermost rule, and each rule
          calls the tighter one inside it — which is why {code('AND')} groups before {code('OR')} does. The parser is
          written the same way: a function for each layer, each calling the next one down.
        </>
      ),
      link: to('grammarExpression', 'Open the expression rules'),
    },
    {
      heading: 'What the diagram does not say',
      body: (
        <>
          The diagram is what the parser can <em>read</em>. The engine refuses some combinations it reads without
          complaint: {code('GROUP BY')} or {code('ORDER BY')} in a query with a {code('JOIN')}. Of the eight optional
          parts of a {code('SELECT')} the most that run together are seven — all but {code('JOIN')}.
        </>
      ),
      link: to('grammarSelect', 'Open the select rule'),
      tryThis: (
        <>
          Write one of the refused combinations in the Playground and read the message: it is the engine&apos;s, not the
          parser&apos;s, and it says &ldquo;not supported yet&rdquo;.
        </>
      ),
    },
  ],

  'planner-rules': [
    {
      heading: 'Two rules make one lookup',
      body: (
        <>
          With every rewrite rule on, {code('WHERE id = 5 AND age > 30')} is rewritten twice. Predicate pushdown folds the
          filter into the scan, and index selection then turns the scan into an {code('IndexScan')} on {code('id')}, with{' '}
          {code('age > 30')} left to check on the row. The plan goes from Project, Filter, SeqScan to Project,
          IndexScan.
        </>
      ),
      link: to('plannerAll', 'Open it with every rule on'),
    },
    {
      heading: 'A rule needs its neighbour',
      body: (
        <>
          Turn off everything but index selection and <em>nothing</em> fires: the plan is the canonical one. The rule
          looks for a predicate already folded into the scan, and on its own the filter is still a separate node above
          it. Of the seven rules, these two are the only pair that gives the lookup.
        </>
      ),
      link: to('plannerIndexOnly', 'Open it with only index selection'),
    },
    {
      heading: 'And without the index',
      body: (
        <>
          Drop the index on {code('id')} and the same rules do what they can: pushdown still folds the filter into the
          scan, and the scan is still a {code('SeqScan')} that reads every page. The rules never invent an index — they
          only choose between what the table has.
        </>
      ),
      link: to('plannerNoIndex', 'Open it with the index off'),
    },
  ],

  'lock-table': [
    {
      heading: 'Readers share',
      body: (
        <>
          Two transactions each ask for a <em>shared</em> lock on page 0. Neither conflicts with the other, so both are
          granted: any number of readers may hold a page at once.
        </>
      ),
      link: to('locksShared', 'Open the two readers'),
    },
    {
      heading: 'A writer waits, and is promoted',
      body: (
        <>
          T1 holds page 0 shared, and T2 asks for it <em>exclusive</em>. The request cannot be granted, so T2 waits behind
          T1. When T1 releases, the lock table promotes T2 in the same step: a waiter is never forgotten, and the queue
          is first come, first served.
        </>
      ),
      link: to('locksQueue', 'Open the writer behind a reader'),
    },
    {
      heading: 'A circle of waits',
      body: (
        <>
          Each transaction holds a page the other wants. Neither can go first, so the table finds the cycle and aborts
          one: T2, because it made its first request after T1 did. T1 is then promoted into the page it was waiting
          for.
        </>
      ),
      link: to('locksDeadlock', 'Open the deadlock'),
      tryThis: (
        <>
          Have T2 ask for a page <em>before</em> T1 asks for anything, then close the circle as before. Now T1 is the one
          that arrived most recently, and it is T1 that is aborted. Which transaction is the victim follows from who
          asked first, not from who happens to be waiting.
        </>
      ),
    },
    {
      heading: 'One page is enough',
      body: (
        <>
          A deadlock does not need two resources. Both transactions take a shared lock on page 0, and then each asks to
          upgrade to exclusive: each is waiting for the other to let go of the very page it holds. The second request
          finds the cycle and the table aborts it.
        </>
      ),
      link: to('locksOnePage', 'Open the upgrade'),
    },
  ],
};
