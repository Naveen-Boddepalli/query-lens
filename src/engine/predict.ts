/**
 * Predict-then-reveal prompts.
 *
 * RESEARCH.md §1: across 24 experiments, passive viewing did not reliably beat
 * reading text "no matter how high the level of their epistemic fidelity" —
 * the gains came from prediction and question-answering. Everything else in
 * this engine is the fidelity half. This is the other half.
 *
 * Every prompt is generated from real engine state, so the correct answer is
 * whatever the engine is actually about to do. None of it is authored.
 */

import type { PredictionPrompt, SqlValue } from './types.ts';
import type { Frame } from './storage/index.ts';

function format(value: SqlValue): string {
  if (value === null) return 'NULL';
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/** "Which frame gets evicted?" — the canonical prompt from the research. */
export function evictionPrompt(
  frames: readonly Frame[],
  victimFrameId: number,
  incomingPage: number,
  policy: 'lru' | 'clock',
): PredictionPrompt | null {
  const occupied = frames.filter((f) => f.pageId !== null);
  if (occupied.length < 2) return null;

  return {
    question: `The pool is full and page ${String(incomingPage)} has to be read in. Under ${
      policy === 'lru' ? 'LRU' : 'clock sweep'
    }, which frame gets evicted?`,
    options: occupied.map((f) => ({
      id: `frame-${String(f.frameId)}`,
      label: `frame ${String(f.frameId)} · page ${String(f.pageId)}`,
    })),
    correctOptionId: `frame-${String(victimFrameId)}`,
    explanation:
      policy === 'lru'
        ? 'LRU evicts whichever page was accessed longest ago. On a sequential scan that is simply the first one still resident.'
        : 'The clock hand walks forward, decrementing usage counts as it goes, and takes the first frame it finds at zero with nothing pinning it.',
  };
}

/** "Which child pointer does the traversal follow?" */
export function traversalPrompt(
  nodeId: string,
  separators: readonly SqlValue[],
  key: SqlValue,
  correctChildIndex: number,
): PredictionPrompt | null {
  if (separators.length === 0) return null;

  const options = Array.from({ length: separators.length + 1 }, (_, i) => {
    const low = i === 0 ? null : separators[i - 1]!;
    const high = i === separators.length ? null : separators[i]!;
    const range =
      low === null
        ? `< ${format(high)}`
        : high === null
          ? `≥ ${format(low)}`
          : `${format(low)} … < ${format(high)}`;
    return { id: `child-${String(i)}`, label: `child ${String(i)}  (${range})` };
  });

  return {
    question: `Node ${nodeId} separates on ${separators.map(format).join(' ')}. Looking for ${format(key)} — which child pointer does the search follow?`,
    options,
    correctOptionId: `child-${String(correctChildIndex)}`,
    explanation:
      'A separator key is the lower bound of the subtree to its right. The search follows the first child whose range contains the key — which is why the tree stays balanced and the lookup costs one read per level.',
  };
}

/** "Where does the filter end up?" — asked before the optimizer rewrites. */
export function indexSelectionPrompt(column: string, key: SqlValue): PredictionPrompt {
  return {
    question: `There is a B+Tree index on \`${column}\`, and the predicate is \`${column} = ${format(key)}\`. What should the optimizer do?`,
    options: [
      { id: 'keep', label: 'Leave the filter above a full sequential scan' },
      { id: 'push', label: 'Turn the scan into an index lookup on that key' },
      { id: 'drop', label: 'Drop the filter — the index makes it redundant' },
    ],
    correctOptionId: 'push',
    explanation:
      'The index finds the matching row directly, so the other pages are never read. Dropping the filter would be wrong in general: an index narrows the search, it does not verify the whole predicate — anything the index cannot answer is rechecked on each row it returns.',
  };
}

/** "How many rows come back?" — asked before the result is revealed. */
export function resultPrompt(actual: number, tableRows: number): PredictionPrompt | null {
  const candidates = [...new Set([0, 1, actual, tableRows])].sort((a, b) => a - b);
  if (candidates.length < 2) return null;

  return {
    question: 'Before the rows are revealed: how many does this query return?',
    options: candidates.map((n) => ({
      id: `rows-${String(n)}`,
      label: n === tableRows ? `${String(n)} (every row)` : String(n),
    })),
    correctOptionId: `rows-${String(actual)}`,
    explanation:
      actual === 0
        ? 'Nothing matched the predicate. A query reading many pages can still return nothing — work done is not the same as rows produced.'
        : `${String(actual)} of ${String(tableRows)} rows satisfied the predicate. Every other row was read and discarded, which is exactly what the buffer pool numbers were counting.`,
  };
}
