import { useState } from 'react';
import { inputField } from '../primitives.ts';

export interface StepperProps {
  id: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** A name for the − and + buttons ("frames"): "Fewer frames", "More frames". */
  unit?: string;
  /** The two buttons' names when "Fewer" and "More" read wrongly, as for picking the next of a list. */
  buttonLabels?: readonly [decrease: string, increase: string];
  describedBy?: string;
  disabled?: boolean;
}

const btn =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-edge bg-surface-3 text-body text-ink-dim ' +
  'shadow-e1 transition duration-150 ease-out select-none hover:border-ink-dim/50 hover:text-ink active:translate-y-px ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-edge disabled:hover:text-ink-dim disabled:active:translate-y-0';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * A small integer range (§4.2 rule 5): − n +. The field still takes typing. A value in range applies as it is typed;
 * one outside it waits, so "32" in a 6–64 field is not clamped to 6 at the "3", and is clamped when the field loses
 * focus. A blank or non-number entry is dropped then, rather than turned into the minimum.
 */
/** Wide enough for the largest value it can hold: two digits fit w-12, four need w-16. */
const WIDTH: Record<number, string> = { 1: 'w-12', 2: 'w-12', 3: 'w-14', 4: 'w-16' };

export function Stepper({ id, value, onChange, min, max, step = 1, unit, buttonLabels, describedBy, disabled = false }: StepperProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const set = (v: number) => {
    const next = clamp(Math.round(v / step) * step, min, max);
    if (next !== value) onChange(next);
  };
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        className={btn}
        onClick={() => { setDraft(null); set(value - step); }}
        disabled={disabled || value <= min}
        aria-label={buttonLabels?.[0] ?? (unit ? `Fewer ${unit}` : 'Decrease')}
      >
        −
      </button>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={step}
        value={draft ?? value}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = e.target.valueAsNumber;
          if (Number.isFinite(n) && n >= min && n <= max) set(n);
        }}
        onBlur={(e) => {
          const n = e.target.valueAsNumber;
          if (Number.isFinite(n)) set(n);
          setDraft(null);
        }}
        className={`${inputField} ${WIDTH[Math.min(String(max).length, 4)] ?? 'w-12'} [appearance:textfield] px-1 text-center tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
      />
      <button
        type="button"
        className={btn}
        onClick={() => { setDraft(null); set(value + step); }}
        disabled={disabled || value >= max}
        aria-label={buttonLabels?.[1] ?? (unit ? `More ${unit}` : 'Increase')}
      >
        +
      </button>
    </div>
  );
}
