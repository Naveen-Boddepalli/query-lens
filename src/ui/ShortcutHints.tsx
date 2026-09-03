import { ENTER_KEY, MOD_KEY, useIsTouch } from './platform.ts';

const SHORTCUTS = [
  { keys: ['Space'], what: 'play / pause' },
  { keys: ['←', '→'], what: 'step' },
  { keys: ['Home'], what: 'reset' },
  { keys: [MOD_KEY, ENTER_KEY], what: 'run' },
];

/**
 * Discoverable, not hidden behind a help modal: plan.md §8 notes that learners
 * in training settings lean on keyboard shortcuts heavily, and a shortcut
 * nobody knows about is a shortcut nobody uses.
 *
 * Nothing at all on a touch device, though: five key names the hardware does
 * not have is not discoverability, it is clutter above the controls that
 * device *does* use (plan.md §15.1 item 6).
 */
export function ShortcutHints() {
  const touch = useIsTouch();
  if (touch) return null;

  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-ink-dim">
      {SHORTCUTS.map((shortcut) => (
        <li key={shortcut.what} className="flex items-center gap-1">
          {shortcut.keys.map((key) => (
            <kbd
              key={key}
              className="rounded border border-edge bg-surface-3 px-1.5 py-0.5 font-mono text-3xs"
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
