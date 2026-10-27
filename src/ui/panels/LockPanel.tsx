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
        <p className="text-body text-ink-dim">
          No locks held right now.
          {taken > 0 && ' Every lock taken so far has been released.'}
        </p>
      ) : (
        <div className="grid gap-1.5" role="table" aria-label="Lock matrix">
          {locks.map((lock) => (
            <div
              key={`${String(lock.pageId)}-${lock.mode}`}
              role="row"
              className="cell ql-sheen flex items-baseline justify-between rounded-lg border border-hue-orange/60 bg-hue-orange/10 px-2.5 py-1.5 font-mono text-label text-hue-orange-ink shadow-e1 hover:border-hue-orange/90 hover:bg-hue-orange/20"
            >
              <span>page {lock.pageId}</span>
              <span className="tracking-wide uppercase opacity-80">{lock.mode}</span>
            </div>
          ))}
        </div>
      )}

      {locks.length === 2 && (
        <p className="ql-sheen rounded-xl border border-hue-orange/40 border-l-2 border-l-hue-orange bg-hue-orange/5 px-3 py-2 text-label leading-relaxed shadow-e1">
          Two at once — this is <span className="text-ink">latch crabbing</span>. The descent takes
          the child&rsquo;s lock <em>before</em> letting go of the parent&rsquo;s, so the branch
          cannot be restructured out from under it.
        </p>
      )}

      <div className="mt-auto space-y-2 text-label leading-relaxed text-ink-dim">
        <p>
          <span className="text-ink">{taken}</span> lock{taken === 1 ? '' : 's'} taken so far.
        </p>
        <p className="rounded-xl border border-edge/60 px-3 py-2">
          <span className="text-ink">This layer is visual only.</span> QueryLens runs one query at a time.
        </p>
      </div>
    </div>
  );
}
