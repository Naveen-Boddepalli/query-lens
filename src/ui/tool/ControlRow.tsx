import type { ReactNode } from 'react';
import { controlLabel } from '../primitives.ts';
import { hintIdFor } from './controlIds.ts';

export interface ControlRowProps {
  label: ReactNode;
  /**
   * The id of a labelable control inside (`<input>`, `<select>`): the label becomes a `<label for>`. For a control
   * that is not labelable (a `Segmented`, a `Switch` group), pass `labelId` instead and point the control's
   * `aria-labelledby` at it.
   */
  htmlFor?: string;
  labelId?: string;
  /**
   * One line of help, or why the control is disabled ("Linear hashing only"). Rendered with the id
   * `${htmlFor ?? labelId}-hint`: point the control's `aria-describedby` at it.
   */
  hint?: ReactNode;
  children: ReactNode;
}

/**
 * Label, control, hint. Side by side (a fixed `--control-label` column) where the row has room, stacked where it
 * does not: a container query, so the same row works in the rail, the tablet bar and on a phone.
 */
export function ControlRow({ label, htmlFor, labelId, hint, children }: ControlRowProps) {
  const id = htmlFor ?? labelId;
  return (
    <div className="@container min-w-0">
      <div className="grid gap-1 @min-[15rem]:grid-cols-[var(--control-label)_minmax(0,1fr)] @min-[15rem]:items-center @min-[15rem]:gap-x-3">
        {htmlFor ? (
          <label htmlFor={htmlFor} className={controlLabel}>
            {label}
          </label>
        ) : (
          <span id={labelId} className={controlLabel}>
            {label}
          </span>
        )}
        <div className="flex min-w-0 items-center gap-2">{children}</div>
        {hint && (
          <p id={id ? hintIdFor(id) : undefined} className="text-label text-ink-dim/80 @min-[15rem]:col-start-2">
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}
