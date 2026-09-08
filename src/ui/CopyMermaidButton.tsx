import { useState } from 'react';

/**
 * plan.md §20.8: a **Copy as Mermaid** action on the AST and plan panels.
 * `src/export/toMermaid.ts` does the pure work; this is just the clipboard
 * plumbing, on the same try/catch pattern as the Playground's "copy link".
 */
export function CopyMermaidButton({ text }: { text: string }) {
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
      title="Copy this tree as a Mermaid flowchart, ready to paste"
    >
      {copied ? 'Copied ✓' : 'Copy as Mermaid'}
    </button>
  );
}
