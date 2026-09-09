import { useState } from 'react';

/**
 * plan.md §20.8 / §22.5: the clipboard plumbing behind the "Copy as Mermaid"
 * and "Copy as text" actions on the diagram panels. The pure work lives in
 * `src/export/`; this is only the write plus the 2 s "Copied ✓" flip, on the
 * same try/catch the Playground's "copy link" uses.
 */
export function CopyButton({
  text,
  label,
  title,
}: {
  text: string;
  /** Resting label, e.g. "Copy as text". Also the button's accessible name. */
  label: string;
  title: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => { setCopied(false); }, 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => { void copy(); }}
      className="rounded-full border border-edge bg-surface-2 px-3 py-1 text-label text-ink-dim shadow-e1 transition hover:border-ink-dim/50 hover:text-ink"
      title={title}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  );
}
