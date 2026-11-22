import type { CSSProperties } from 'react';

/** The five families the Tools index groups its tools into. */
export type ToolCategory = 'storage' | 'indexing' | 'query' | 'transactions' | 'distributed';

/**
 * Each category borrows the colour of the pipeline stage it lives in, so a
 * storage tool is the buffer pool's coral everywhere: on its card in the Tools
 * index, and on the tool's own stage panel, active options and transport.
 */
export const CATEGORY_STAGE: Record<ToolCategory, string> = {
  storage: 'buffer',
  indexing: 'index',
  query: 'execute',
  transactions: 'lock',
  distributed: 'parse',
};

/** Sets `--stage` (a registered `<color>`, so it cross-fades) to the category's stage colour. */
export const stageStyle = (category: ToolCategory): CSSProperties =>
  ({ '--stage': `var(--color-stage-${CATEGORY_STAGE[category]})` }) as CSSProperties;
