const SHORTCUTS = [
  { keys: ['Space'], what: 'play / pause' },
  { keys: ['←', '→'], what: 'step' },
  { keys: ['Home'], what: 'reset' },
  { keys: ['⌘', '↵'], what: 'run' },
] as const;

/**
 * Discoverable, not hidden behind a help modal: plan.md §8 notes that learners
 * in training settings lean on keyboard shortcuts heavily, and a shortcut
 * nobody knows about is a shortcut nobody uses.
 */
export function ShortcutHints() {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-dim">
      {SHORTCUTS.map((shortcut) => (
        <li key={shortcut.what} className="flex items-center gap-1">
          {shortcut.keys.map((key) => (
            <kbd
              key={key}
              className="rounded border border-edge bg-surface-3 px-1.5 py-0.5 font-mono text-[10px]"
            >
              {key}
            </kbd>
          ))}
          <span className="ml-0.5">{shortcut.what}</span>
        </li>
      ))}
    </ul>
  );
}
