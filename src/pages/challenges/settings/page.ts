/** The slotted-page challenge, laid out by the page tool's own function. */

import { buildHeap, createSeedDatabase, DEFAULT_ENGINE_OPTIONS } from '../../../engine/index.ts';
import { layOutPage } from '../../../ui/slottedPage.ts';
import { storageHref } from '../../learn/storageScenarios.ts';
import { num } from './shared.ts';
import type { Checkers } from './shared.ts';

// — the slotted page's demo, as the page tool builds it —

function usersPages() {
  const users = createSeedDatabase().tables.users!;
  return { users, heap: buildHeap(users, DEFAULT_ENGINE_OPTIONS.rowsPerPage) };
}

export const CHECKERS: Checkers = {
  'tightest-page': (v) => {
    const { users, heap } = usersPages();
    const [pageId, bytes] = [num(v, 'page'), num(v, 'bytes')];
    const page = heap.pages[pageId];
    if (!page) {
      return { passed: false, facts: [], problem: `There is no heap page ${String(pageId)}.`, toolHref: '/tools/page' };
    }
    const l = layOutPage(page.rows, users.columns, { pageBytes: bytes });
    const data = l.tuples.reduce((n, t) => n + t.fields.reduce((m, f) => m + f.bytes, 0), 0);
    return {
      passed: !l.overflow && l.freeBytes === 0,
      facts: [
        { label: 'rows', value: String(page.rows.length) },
        { label: 'bytes the rows need', value: String(l.usedBytes) },
        { label: 'of which the rows’ own data', value: String(data) },
        { label: 'page size', value: String(bytes) },
        { label: 'free', value: l.overflow ? 'overflow' : String(l.freeBytes) },
      ],
      toolHref: storageHref({ tool: 'page', page: pageId, bytes }),
    };
  },
};
