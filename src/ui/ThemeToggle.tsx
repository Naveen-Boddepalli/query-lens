import type { ThemeChoice, ThemeState } from './theme.ts';

/**
 * Three states, not two (plan.md §15.3).
 *
 * A two-state switch has to decide what it means on first load, and whichever
 * it picks it has silently stopped following the system — which is the setting
 * the user already made once, for every app. "System" is the default and stays
 * selectable, so choosing light and changing your mind is reversible.
 *
 * A radiogroup rather than buttons: these are three values of one setting, and
 * a screen reader should hear which is current, not three unrelated controls.
 */
const OPTIONS: { value: ThemeChoice; label: string; glyph: string; title: string }[] = [
  { value: 'system', label: 'System', glyph: '◐', title: 'Follow the system setting' },
  { value: 'light', label: 'Light', glyph: '☀', title: 'Always light' },
  { value: 'dark', label: 'Dark', glyph: '☾', title: 'Always dark' },
];

export function ThemeToggle({ choice, setChoice }: Pick<ThemeState, 'choice' | 'setChoice'>) {
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-md border border-edge bg-surface-2 p-0.5"
    >
      {OPTIONS.map((option) => {
        const selected = choice === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={option.title}
            onClick={() => { setChoice(option.value); }}
            className={[
              // 24px minimum on both axes: WCAG 2.2 SC 2.5.8, the same rule
              // that set the scrubber's size (plan.md §15.1 item 8).
              'flex h-6 min-w-7 items-center justify-center rounded px-1 text-micro transition-colors',
              selected
                ? 'bg-accent/20 text-ink'
                : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
            ].join(' ')}
          >
            <span aria-hidden>{option.glyph}</span>
            <span className="sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
