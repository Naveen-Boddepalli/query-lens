/**
 * ⚠️  SCAFFOLD ONLY — M0.
 *
 * A hand-written trace whose only job is to exercise the fold + playback loop
 * before any real engine exists. It is NOT produced by executing anything, so
 * every `RunResult` built from it carries `synthetic: true` and the UI says so
 * out loud.
 *
 * Deleted for good once M5 wires parser → planner → executor together.
 */

import { createTracer } from './trace.ts';
import type { ASTNode, PlanNode, RunResult, Row } from './types.ts';

const ast: ASTNode = {
  kind: 'SelectStatement',
  label: 'SELECT',
  children: [
    {
      kind: 'ColumnList',
      label: 'columns',
      children: [{ kind: 'Star', label: '*' }],
    },
    { kind: 'From', label: 'FROM users' },
    {
      kind: 'Where',
      label: 'WHERE',
      children: [
        {
          kind: 'BinaryExpr',
          label: '=',
          children: [
            { kind: 'Column', label: 'id' },
            { kind: 'Literal', label: '5' },
          ],
        },
      ],
    },
  ],
};

const naivePlan: PlanNode = {
  op: 'Project',
  label: 'Project *',
  children: [
    {
      op: 'Filter',
      label: 'Filter id = 5',
      children: [{ op: 'SeqScan', label: 'SeqScan users', detail: '12 rows' }],
    },
  ],
};

const optimisedPlan: PlanNode = {
  op: 'Project',
  label: 'Project *',
  children: [
    {
      op: 'IndexScan',
      label: 'IndexScan users.id',
      detail: 'id = 5 pushed into the scan',
    },
  ],
};

const resultRows: Row[] = [{ id: 5, name: 'ada', email: 'ada@example.com' }];

export function buildPlaceholderTrace(): RunResult {
  const { emit, drain } = createTracer();

  emit('Tokenise the query text and build an abstract syntax tree.', {
    stage: 'parse',
    ast,
  });

  emit('Turn the AST into a logical plan: scan, then filter, then project.', {
    stage: 'plan',
    planTree: naivePlan,
  });

  emit(
    'Predicate pushdown: `id = 5` matches an index, so the filter collapses into an index scan.',
    { stage: 'optimize', rule: 'predicate-pushdown', before: naivePlan, after: optimisedPlan },
    {
      predictable: {
        question: 'There is a B+Tree index on `users.id`. What should the optimiser do with `WHERE id = 5`?',
        options: [
          { id: 'keep', label: 'Leave the filter above a full sequential scan' },
          { id: 'push', label: 'Push it into the scan and use the index' },
          { id: 'drop', label: 'Drop the filter — the index makes it redundant' },
        ],
        correctOptionId: 'push',
        explanation:
          'Pushing the predicate into the scan lets the index find the matching row directly, so the engine never reads the other pages. Dropping the filter would be wrong: the index narrows the search, it does not verify the predicate on its own.',
      },
    },
  );

  emit('Acquire a shared lock on the index root page.', {
    stage: 'lock',
    action: 'acquire',
    pageId: 0,
    mode: 'shared',
  });

  emit('Root page 0 is not in the buffer pool — a miss.', {
    stage: 'buffer',
    action: 'miss',
    pageId: 0,
    frameId: 0,
  });
  emit('Read page 0 from disk into frame 0.', {
    stage: 'buffer',
    action: 'load',
    pageId: 0,
    frameId: 0,
  });
  emit('Walk the B+Tree root: 5 < 9, so follow the left child pointer.', {
    stage: 'index',
    action: 'traverse',
    nodeId: 'n0',
    key: 5,
  });

  emit('Leaf page 3 is not resident either.', {
    stage: 'buffer',
    action: 'miss',
    pageId: 3,
    frameId: 1,
  });
  emit('Read page 3 from disk into frame 1.', {
    stage: 'buffer',
    action: 'load',
    pageId: 3,
    frameId: 1,
  });
  emit('Reach the leaf node holding keys 4–6.', {
    stage: 'index',
    action: 'traverse',
    nodeId: 'n3',
    key: 5,
  });
  emit('Key 5 found — the leaf points at the row on heap page 7.', {
    stage: 'index',
    action: 'found',
    nodeId: 'n3',
    key: 5,
  });

  emit('The row itself lives on heap page 7, which is not resident either.', {
    stage: 'buffer',
    action: 'miss',
    pageId: 7,
    frameId: 2,
  });
  emit('Read heap page 7 from disk into frame 2.', {
    stage: 'buffer',
    action: 'load',
    pageId: 7,
    frameId: 2,
  });

  emit('IndexScan emits the single matching row.', {
    stage: 'execute',
    op: 'IndexScan',
    rowsProduced: 1,
  });
  emit('Project passes the row through untouched (SELECT *).', {
    stage: 'execute',
    op: 'Project',
    rowsProduced: 1,
  });

  emit('Release the shared lock on page 0.', {
    stage: 'lock',
    action: 'release',
    pageId: 0,
    mode: 'shared',
  });

  emit(
    'Return the result set: 1 row from 3 disk reads and no buffer hits — the pool started cold. Run it again and all three pages would be hits.',
    { stage: 'result', rows: resultRows },
  );

  return { events: drain(), rows: resultRows, synthetic: true };
}
