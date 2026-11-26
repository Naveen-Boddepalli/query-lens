import type { Page } from '@playwright/test';

/** One thing that does not fit: what it is, where, and by how much. */
export interface Overflow {
  kind: 'page' | 'escapes-card' | 'clipped';
  /** A short description of the element: tag, classes and the start of its text. */
  what: string;
  /** How many pixels stick out or are cut off. */
  by: number;
}

/**
 * Everything on the current page that does not fit its box at this viewport (docs/research/tool-layouts.md §5.1,
 * phase 0). Three failures, all of which the tool-layout audit found by eye at 375px:
 *
 * - **page**: the document, or the layout's scroll pane, is wider than the viewport (2PC's select did this).
 * - **escapes-card**: an element sticks out past the card it sits in, with no scroll container between them to
 *   reach it by.
 * - **clipped**: a box that hides its overflow is cutting off its own content (a label in the slotted page's map).
 *
 * A box that scrolls is not a failure: that is the fix, with `ScrollRegion`'s edge fade saying there is more. Nor are
 * the parts that are clipped on purpose: visually hidden text, a `truncate`d line (it shows an ellipsis), a diagram
 * canvas (it pans and zooms), an SVG's insides, and decoration that is `aria-hidden`.
 */
export function findOverflows(page: Page): Promise<Overflow[]> {
  return page.evaluate(() => {
    const out: { kind: 'page' | 'escapes-card' | 'clipped'; what: string; by: number }[] = [];
    const describe = (el: Element) => {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 6).join('.') : '';
      const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}> "${text}"`;
    };
    const scrolls = (el: Element) => /(auto|scroll)/.test(getComputedStyle(el).overflowX);
    const exempt = (el: Element) =>
      el.closest('.sr-only, .react-flow, svg, [aria-hidden="true"], .ql-route-progress') !== null ||
      getComputedStyle(el).textOverflow === 'ellipsis';

    // The page itself, and the layout's own scroll pane (Layout.tsx), which is where 2PC's overflow showed.
    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) out.push({ kind: 'page', what: '<html>', by: doc.scrollWidth - doc.clientWidth });
    for (const pane of document.querySelectorAll('#root [class*="overflow-y-auto"]')) {
      if (pane.scrollWidth > pane.clientWidth + 1) out.push({ kind: 'page', what: describe(pane).slice(0, 80), by: pane.scrollWidth - pane.clientWidth });
    }

    // A card is a bordered, rounded surface: every panel, card and toolbar the tools draw.
    const cards = [...document.querySelectorAll('#root .rounded-xl.border')];
    for (const card of cards) {
      const box = card.getBoundingClientRect();
      if (box.width === 0) continue;
      for (const el of card.querySelectorAll('*')) {
        if (exempt(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;

        // Sticking out of the card: only a failure when no box between the two contains it. A scroll container
        // brings it into reach (fine); a box that hides overflow cuts it off (reported once, as that box's clip).
        const past = Math.max(r.right - box.right, box.left - r.left);
        if (past > 1) {
          let contained = false;
          for (let p = el.parentElement; p && p !== card; p = p.parentElement) {
            if (getComputedStyle(p).overflowX !== 'visible') { contained = true; break; }
          }
          if (!contained && !scrolls(card)) out.push({ kind: 'escapes-card', what: describe(el), by: Math.round(past) });
        }

        // A box that hides overflow and has more content than room.
        const cs = getComputedStyle(el);
        if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 1) {
          out.push({ kind: 'clipped', what: describe(el), by: el.scrollWidth - el.clientWidth });
        }
      }
    }
    // An element inside nested cards is checked once per card: report each one once.
    const seen = new Set<string>();
    return out.filter((o) => {
      const key = `${o.kind}|${o.what}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

/**
 * Lets a full-page screenshot capture the whole tool at `lg`, where Layout pins the shell to the viewport height
 * and scrolls an inner pane instead of the document: undo that pinning for the shot.
 */
export async function unpinLayout(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `.lg\\:h-dvh{height:auto!important}.lg\\:overflow-hidden{overflow:visible!important}#root .lg\\:overflow-y-auto{overflow:visible!important}`,
  });
}
