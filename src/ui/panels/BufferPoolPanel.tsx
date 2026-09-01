import type { BufferFrame, StepEvent } from '../../engine/index.ts';

export interface BufferPoolPanelProps {
  frames: BufferFrame[];
  stats: { hits: number; misses: number; evictions: number };
  clockHand: number;
  policy: 'lru' | 'clock';
  lastEvent: StepEvent | null;
}

function frameTone(frame: BufferFrame, lastEvent: StepEvent | null): string {
  if (lastEvent?.stage === 'buffer' && lastEvent.frameId === frame.frameId) {
    if (lastEvent.action === 'hit') return 'border-hit bg-hit/15';
    if (lastEvent.action === 'load') return 'border-miss bg-miss/15';
    if (lastEvent.action === 'evict') return 'border-evict bg-evict/15';
    if (lastEvent.action === 'sweep') return 'border-accent bg-accent/10';
  }
  return frame.pageId === null ? 'border-edge/60 bg-transparent' : 'border-edge bg-surface-3';
}

export function BufferPoolPanel({ frames, stats, clockHand, policy, lastEvent }: BufferPoolPanelProps) {
  const total = stats.hits + stats.misses;
  const hitRate = total === 0 ? '—' : `${Math.round((stats.hits / total) * 100)}%`;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-2">
        {frames.map((frame) => (
          <div
            key={frame.frameId}
            className={`rounded-lg border p-2.5 transition-colors ${frameTone(frame, lastEvent)}`}
          >
            <div className="flex items-baseline justify-between text-[10px] text-ink-dim">
              <span>frame {frame.frameId}</span>
              {policy === 'clock' && clockHand === frame.frameId && <span title="clock hand">🕐</span>}
            </div>
            <div className="mt-1 font-mono text-sm">
              {frame.pageId === null ? (
                <span className="text-ink-dim/60">empty</span>
              ) : (
                <span>page {frame.pageId}</span>
              )}
            </div>
            {policy === 'clock' && frame.pageId !== null && (
              <div className="mt-1 text-[10px] text-ink-dim">usage {frame.usageCount}/5</div>
            )}
          </div>
        ))}
      </div>

      <dl className="flex gap-5 text-xs">
        <div><dt className="text-ink-dim">hits</dt><dd className="font-mono text-hit">{stats.hits}</dd></div>
        <div><dt className="text-ink-dim">misses</dt><dd className="font-mono text-miss">{stats.misses}</dd></div>
        <div><dt className="text-ink-dim">evictions</dt><dd className="font-mono text-evict">{stats.evictions}</dd></div>
        <div><dt className="text-ink-dim">hit rate</dt><dd className="font-mono">{hitRate}</dd></div>
      </dl>
    </div>
  );
}
