import { useState } from 'react';
import { createTree, insert, search, toIndexDisplay } from '../engine/index.ts';
import type { BPlusTree } from '../engine/index.ts';
import { BTreePanel } from './panels/BTreePanel.tsx';
import { btnPrimary, inputField } from './primitives.ts';

const SAMPLE_KEYS = [10, 20, 30, 40, 50, 15, 25, 35, 5, 45, 12, 28, 33, 48];

function buildSampleTree(): BPlusTree {
  const tree = createTree(4, 0);
  for (const key of SAMPLE_KEYS) insert(tree, key, { pageId: key >> 2, slot: key & 3 });
  return tree;
}

/**
 * A live B+Tree search, embedded directly in the B+Tree concept page
 * (plan.md §23.1's interactive-docs item) — the same `search()`/`BTreePanel`
 * pair the `/tools/btree` sandbox drives, reduced to a single input rather
 * than a full insert/delete workbench, so the reader can try a few keys
 * without leaving the page they're reading.
 */
export function BTreeMiniDemo() {
  const [tree] = useState(buildSampleTree);
  const [input, setInput] = useState('30');
  const [key, setKey] = useState<number | null>(30);

  const result = key === null ? null : search(tree, key);
  const outcome = result === null ? null : result.pointer ? 'found' : 'not-found';

  function runSearch() {
    const n = Number(input);
    setKey(Number.isInteger(n) ? n : null);
  }

  return (
    <div className="not-prose my-6 rounded-xl border border-edge bg-surface-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-label text-ink-dim">
          Find key
          <input
            value={input}
            onChange={(e) => { setInput(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
            className={`${inputField} w-20 font-mono`}
            inputMode="numeric"
            aria-label="Key to search for"
          />
        </label>
        <button type="button" onClick={runSearch} className={btnPrimary}>
          Find
        </button>
        <span className="text-label text-ink-dim">
          {[...SAMPLE_KEYS].sort((a, b) => a - b).join(', ')} are in the tree — try one, or a key
          that isn't.
        </span>
      </div>
      <div className="mt-3 h-72">
        <BTreePanel tree={toIndexDisplay(tree)} path={result?.path ?? []} outcome={outcome} />
      </div>
    </div>
  );
}
