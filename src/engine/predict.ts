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

import type { PredictionPrompt, ReplacementPolicyName, SqlValue } from './types.ts';
import type { Frame } from './storage/index.ts';

function format(value: SqlValue): string {
  if (value === null) return 'NULL';
  return typeof value === 'string' ? `'${value}'` : String(value);
}

const POLICY_LABEL: Record<ReplacementPolicyName, string> = {
  lru: 'LRU',
  clock: 'clock sweep',
  fifo: 'FIFO',
  'second-chance': 'second-chance',
  optimal: 'the optimal policy',
  midpoint: 'midpoint LRU',
  'lru-k': 'LRU-2',
};

const POLICY_WHY: Record<ReplacementPolicyName, string> = {
  lru: 'LRU evicts whichever page was accessed longest ago. On a sequential scan that is simply the first one still resident.',
  clock:
    'The clock hand walks forward, decrementing usage counts as it goes, and takes the first frame it finds at zero with nothing pinning it.',
  fifo: 'FIFO evicts whichever page has been resident longest, regardless of how often it has been used since — which is exactly what clock sweep sets out to fix.',
  'second-chance':
    'Second-chance is FIFO with a reprieve: a page used since it loaded is passed over once, its reference bit cleared, and sent to the back of the queue. The victim is the oldest page that has not been touched.',
  optimal:
    'The optimal policy evicts the page whose next use is farthest in the future. It cannot be built for real — nothing knows the future — but it is the fewest-misses bound every real policy is judged against.',
  midpoint:
    'Midpoint LRU keeps an "old" sublist of pages read but not yet re-used. New pages land there, and eviction takes the least-recently-used one — so a one-pass scan flushes only itself, never the hot pages in the young sublist.',
  'lru-k':
    'LRU-2 evicts by the time of each page\'s second-most-recent reference. A page touched only once has no second reference at all, so it goes first, and a page touched twice survives a one-pass scan.',
};

/** "Which frame gets evicted?" — the canonical prompt from the research. */
export function evictionPrompt(
  frames: readonly Frame[],
  victimFrameId: number,
  incomingPage: number,
  policy: ReplacementPolicyName,
): PredictionPrompt | null {
  const occupied = frames.filter((f) => f.pageId !== null);
  if (occupied.length < 2) return null;

  return {
    question: `The pool is full and page ${String(incomingPage)} has to be read in. Under ${POLICY_LABEL[policy]}, which frame gets evicted?`,
    options: occupied.map((f) => ({
      id: `frame-${String(f.frameId)}`,
      label: `frame ${String(f.frameId)} · page ${String(f.pageId)}`,
    })),
    correctOptionId: `frame-${String(victimFrameId)}`,
    explanation: POLICY_WHY[policy],
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
export function indexSelectionPrompt(column: string, key: SqlValue, predicate = `${column} = ${format(key)}`): PredictionPrompt {
  return {
    question: `There is a B+Tree index on ${column.startsWith('(') ? column : `\`${column}\``}, and the predicate is \`${predicate}\`. What should the optimizer do?`,
    options: [
      { id: 'keep', label: 'Leave it as a full sequential scan' },
      { id: 'push', label: 'Turn the scan into an index lookup on that key' },
      { id: 'drop', label: 'Drop the filter — the index makes it redundant' },
    ],
    correctOptionId: 'push',
    explanation:
      'The index finds the matching row directly, so the other pages are never read. Dropping the filter would be wrong in general: an index narrows the search, it does not verify the whole predicate — anything the index cannot answer is rechecked on each row it returns.',
  };
}

/**
 * "Can the index answer this?" — asked when a composite index is entered through only some of its leading columns
 * (plan.md §25.4 B3): the leftmost-prefix rule. The wrong answers are the two natural mistakes: that the index needs
 * *every* column to be constrained, and that it can serve a predicate on any one of its columns.
 */
export function leftmostPrefixPrompt(index: string, columns: readonly string[], named: readonly string[]): PredictionPrompt {
  const missing = columns.filter((c) => !named.includes(c));
  return {
    question: `There is one B+Tree index on (${columns.join(', ')}), and the predicate is an equality on ${named.map((c) => `\`${c}\``).join(' and ')} only. Can the optimizer use the index?`,
    options: [
      { id: 'yes', label: `Yes — ${named.length === 1 ? 'that is the index\'s leftmost column' : 'those are its leftmost columns'}, so it can be entered there and read along the matching run` },
      { id: 'no-all', label: `No — a composite index only helps when every one of its columns is constrained` },
      { id: 'no-scan', label: `No — an index on several columns is only used for a full scan of the table anyway` },
    ],
    correctOptionId: 'yes',
    explanation: `The entries are ordered by \`${columns[0]}\` first, then by the next column within each value of the one before. An equality on the leading column${named.length > 1 ? 's' : ''} selects one contiguous run of entries, so \`${index}\` is usable — the columns it does not name (${missing.map((c) => `\`${c}\``).join(', ')}) only order the entries inside that run. The reverse is not true: an equality on \`${missing[0]}\` alone matches entries scattered through the whole index, so it could not be used.`,
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
