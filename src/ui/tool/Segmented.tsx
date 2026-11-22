import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { segBase, segOff, segOn } from '../primitives.ts';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** The option's accessible name when `label` is a glyph or an abbreviation. */
  ariaLabel?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** The group's name, or `labelledBy` pointing at a visible label (a `ControlRow`'s `labelId`). */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  /** `sm` for a view switch in a panel header; `md` for a parameter. */
  size?: 'sm' | 'md';
  /** `stage` tints the chosen option with the tool's family hue (inside a `ToolShell`); `accent` everywhere else. */
  tone?: 'accent' | 'stage';
}

const track =
  'inline-grid max-w-full grid-flow-col auto-cols-fr gap-1 rounded-xl border border-edge bg-surface-3/50 p-1 shadow-e1';
const small = 'px-2.5! py-1! text-label!';

/**
 * Two to five exclusive options (§4.2 rule 5). A radio group with a track and equal-width options, keyboard-operable
 * the way a radio group is: one tab stop on the chosen option, arrows move and choose, Home and End jump.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  labelledBy,
  describedBy,
  size = 'md',
  tone = 'accent',
}: SegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const current = options.findIndex((o) => o.value === value);
  // The tab stop is the chosen option, or the first enabled one when nothing valid is chosen.
  const tabStop = current >= 0 && !options[current]?.disabled ? current : (enabled[0] ?? -1);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (enabled.length === 0) return;
    const at = Math.max(enabled.indexOf(tabStop), 0);
    let next: number | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = enabled[(at + 1) % enabled.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (next === undefined) return;
    e.preventDefault();
    const option = options[next];
    if (option) onChange(option.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={track}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.ariaLabel}
            disabled={o.disabled}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => { onChange(o.value); }}
            onKeyDown={onKeyDown}
            className={`${segBase} min-w-0 disabled:cursor-not-allowed disabled:opacity-40 ${size === 'sm' ? small : ''} ${
              on ? (tone === 'stage' ? 'ql-seg-on-stage' : segOn) : segOff
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
