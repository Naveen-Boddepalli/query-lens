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
  describedBy?: string;
  disabled?: boolean;
}

const btn =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-edge bg-surface-3 text-body text-ink-dim ' +
  'shadow-e1 transition duration-150 ease-out select-none hover:border-ink-dim/50 hover:text-ink active:translate-y-px ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-edge disabled:hover:text-ink-dim disabled:active:translate-y-0';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * A small integer range (§4.2 rule 5): − n +. The field still takes typing; a typed value outside the range is
 * clamped, and a blank or non-number entry is ignored rather than turned into the minimum.
 */
export function Stepper({ id, value, onChange, min, max, step = 1, unit, describedBy, disabled = false }: StepperProps) {
  const set = (v: number) => {
    const next = clamp(v, min, max);
    if (next !== value) onChange(next);
  };
  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        className={btn}
        onClick={() => { set(value - step); }}
        disabled={disabled || value <= min}
        aria-label={unit ? `Fewer ${unit}` : 'Decrease'}
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
        value={value}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(e) => {
          const n = e.target.valueAsNumber;
          if (Number.isFinite(n)) set(Math.round(n / step) * step);
        }}
        className={`${inputField} w-16 text-center tabular-nums`}
      />
      <button
        type="button"
        className={btn}
        onClick={() => { set(value + step); }}
        disabled={disabled || value >= max}
        aria-label={unit ? `More ${unit}` : 'Increase'}
      >
        +
      </button>
    </div>
  );
}
