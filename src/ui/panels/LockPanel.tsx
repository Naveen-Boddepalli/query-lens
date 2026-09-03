import type { LockHeld } from '../../engine/index.ts';

export interface LockPanelProps {
  locks: LockHeld[];
  /** Total acquisitions so far in the trace. */
  taken: number;
}

export function LockPanel({ locks, taken }: LockPanelProps) {
  return (
    <div className="flex h-full flex-col gap-3">
      {locks.length === 0 ? (
        <p className="text-sm text-ink-dim">
          No locks held right now.
          {taken > 0 && ' Every lock taken so far has been released.'}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {locks.map((lock) => (
            <li
              key={`${String(lock.pageId)}-${lock.mode}`}
              className="flex items-baseline justify-between rounded-md border border-hue-orange/60 bg-hue-orange/10 px-2.5 py-1.5 font-mono text-xs text-hue-orange-ink"
            >
              <span>🔒 page {lock.pageId}</span>
              <span className="text-3xs tracking-wide uppercase opacity-80">{lock.mode}</span>
            </li>
          ))}
        </ul>
      )}

      {locks.length === 2 && (
        <p className="rounded-md border border-edge bg-surface-3 px-2.5 py-2 text-2xs leading-relaxed">
          Two at once — this is <span className="text-ink">latch crabbing</span>. The descent takes
          the child&rsquo;s lock <em>before</em> letting go of the parent&rsquo;s, so the branch
          cannot be restructured out from under it. The overlap is the technique.
        </p>
      )}

      <div className="mt-auto space-y-2 text-2xs leading-relaxed text-ink-dim">
        <p>
          <span className="text-ink">{taken}</span> lock
          {taken === 1 ? '' : 's'} taken so far. A sequential scan holds one page at a time; an index
          descent briefly holds two.
        </p>
        <p className="rounded-md border border-edge/60 px-2.5 py-2">
          <span className="text-ink">This layer is visual only.</span> QueryLens runs exactly one
          query, so no lock ever waits on another — nothing here is being protected from a rival.
          Real engines also separate a short <em>latch</em> on the buffer frame from a
          transaction-length <em>lock</em> on the data; both are collapsed here into one page-level
          read lock. A second, concurrent query is the v1 feature that would make this layer mean
          something.
        </p>
      </div>
    </div>
  );
}
