import type { ReactNode } from 'react';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** States the rule when on ("Write the log before the page"), so the label reads true or false, not "enabled". */
  label: ReactNode;
  id?: string;
  describedBy?: string;
  disabled?: boolean;
}

/**
 * A binary setting (§4.2 rule 5). A `role="switch"` button whose whole width, label included, is the target, so the
 * hit area is the text a reader is looking at rather than a 2rem track beside it.
 */
export function Switch({ checked, onChange, label, id, describedBy, disabled = false }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => { onChange(!checked); }}
      className="group inline-flex min-h-8 max-w-full items-center gap-2.5 rounded-lg text-left text-body text-ink select-none disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition duration-150 ease-out ${
          checked ? 'border-accent/70 bg-accent' : 'border-edge bg-surface-4'
        }`}
      >
        <span
          className={`h-3.5 w-3.5 rounded-full bg-white shadow-e1 transition-transform duration-150 ease-out ${
            checked ? 'translate-x-[1.125rem]' : 'translate-x-0.5'
          }`}
        />
      </span>
      <span className="min-w-0">{label}</span>
    </button>
  );
}
