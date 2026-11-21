import { useEffect, useState, type ReactNode } from 'react';
import { PageHeader } from '../PageHeader.tsx';

const SEEN_KEY = 'querylens:tool-about-seen';

/** The tools whose About this browser has already seen. A blocked store reads as "none": the About opens again. */
function seenTools(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function markSeen(id: string): void {
  try {
    const seen = seenTools();
    if (!seen.includes(id)) localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, id]));
  } catch {
    // Private window or blocked site data: the About opens again next time, which is all that is lost.
  }
}

export interface ToolHeaderProps {
  /** The tool's route id (`buffer-pool`): keys the About's first-visit memory. */
  id: string;
  title: string;
  /** One sentence. The longer explanation goes in `about`. */
  summary: ReactNode;
  /** The long blurb: open on a first visit, collapsed after. */
  about?: ReactNode;
  /** Tool-level meta actions (share, reset, download), right-aligned. */
  actions?: ReactNode;
}

/**
 * Breadcrumbs, title, one-sentence summary, an "About this tool" disclosure and the meta actions. Built on
 * `PageHeader` so every tool gets the same breadcrumbs and document title as the rest of the site.
 */
export function ToolHeader({ id, title, summary, about, actions }: ToolHeaderProps) {
  // Read once, then marked seen: the next visit opens collapsed, this one stays open while it is read.
  const [openOnLoad] = useState(() => !seenTools().includes(id));
  useEffect(() => { markSeen(id); }, [id]);

  return (
    <PageHeader
      breadcrumbs={[{ label: 'Tools', to: '/tools' }, { label: title }]}
      title={title}
      actions={actions}
    >
      <p>{summary}</p>
      {about && (
        <details open={openOnLoad} className="group mt-2">
          <summary className="inline-flex cursor-pointer items-center gap-1 text-label font-medium text-ink-dim select-none hover:text-ink">
            <span aria-hidden="true" className="transition-transform group-open:rotate-90">▸</span>
            About this tool
          </summary>
          <div className="mt-2 flex flex-col gap-2 text-label leading-relaxed">{about}</div>
        </details>
      )}
    </PageHeader>
  );
}
