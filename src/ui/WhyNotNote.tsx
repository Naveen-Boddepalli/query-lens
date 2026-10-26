import type { WhyNot } from '../engine/index.ts';

/**
 * The "Why not?" panel (plan.md §25.4 C5, fourth and final slice): a cost-based decision's chosen option next
 * to the runner-up it beat, both priced the same way `EXPLAIN` already prices a plan. Every C5 mechanism
 * (index vs. scan, join algorithm, join order) already says this in the step's own narration sentence; this is
 * the same comparison pulled out into its own small, scannable panel rather than left for a reader to parse out
 * of a longer paragraph.
 */
export function WhyNotNote({ whyNot }: { whyNot: WhyNot }) {
  const { chosen, runnerUp } = whyNot;
  const pages = (n: number) => `${String(n)} page${n === 1 ? '' : 's'}`;
  return (
    <div className="rounded-lg border border-edge bg-surface-2 px-3 py-2 text-label">
      <p className="font-medium text-ink-dim">Why not {runnerUp.label}?</p>
      <p className="mt-0.5 text-ink-dim">
        An estimated {pages(runnerUp.estPages)} — against <span className="text-ink">{chosen.label}</span>'s{' '}
        {pages(chosen.estPages)}, the one actually chosen.
      </p>
    </div>
  );
}
