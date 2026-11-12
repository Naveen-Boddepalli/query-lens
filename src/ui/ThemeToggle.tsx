import type { JSX } from 'react';
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
 * Zero emojis directive: uses clean monochrome SVG icons with technical precision.
 */

function SystemIcon(): JSX.Element {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2a6 6 0 0 1 0 12V2z" fill="currentColor" />
    </svg>
  );
}

function SunIcon(): JSX.Element {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13.5 9.2A6 6 0 1 1 6.8 2.5a4.7 4.7 0 0 0 6.7 6.7z" />
    </svg>
  );
}

const OPTIONS: { value: ThemeChoice; label: string; icon: () => JSX.Element; title: string }[] = [
  { value: 'system', label: 'System', icon: SystemIcon, title: 'Follow the system setting' },
  { value: 'light', label: 'Light', icon: SunIcon, title: 'Always light' },
  { value: 'dark', label: 'Dark', icon: MoonIcon, title: 'Always dark' },
];

export function ThemeToggle({ choice, setChoice }: Pick<ThemeState, 'choice' | 'setChoice'>) {
  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-full border border-edge bg-surface-2 p-0.5 shadow-e1"
    >
      {OPTIONS.map((option) => {
        const selected = choice === option.value;
        const Icon = option.icon;
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
              'flex h-6 min-w-7 items-center justify-center rounded-full px-1.5 text-label select-none ' +
              'transition duration-150 ease-out active:translate-y-px',
              selected
                ? 'border border-accent/40 bg-accent-soft text-ink shadow-e1'
                : 'border border-transparent text-ink-dim hover:bg-surface-3 hover:text-ink',
            ].join(' ')}
          >
            <Icon />
            <span className="sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

