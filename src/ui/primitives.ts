/**
 * Shared className strings for recurring surfaces and controls.
 *
 * Module-scoped constants, not components — the same idiom `TopNav`'s
 * `linkClass`, `PlaybackControls`' `btn` and `FlowTree`'s `ZOOM_BUTTON` already
 * use. Importing a string keeps the visual language in one place without adding
 * a component layer or a runtime.
 *
 * Every control variant bakes in a ≥24px target (WCAG 2.2 SC 2.5.8, the rule
 * that also sized the scrubber and the theme toggle) and an `active:` press
 * state; the focus ring is global (`:focus-visible` in index.css).
 *
 * The elevation (`shadow-e1..3`, `shadow-glow`), the roomier radius scale and
 * the `--sheen`/`.ql-sheen` top highlight are all defined in index.css.
 */

/* ----- buttons ----------------------------------------------------------- */

/** The one primary action on a view. A solid iris→orchid fill (`.ql-fill-accent`
 *  in index.css) with white text — the only saturated block on most screens, so
 *  the eye lands on it first. Hover lifts it a hair and lights the glow. */
export const btnPrimary =
  'ql-fill-accent inline-flex items-center justify-center gap-1.5 rounded-lg border ' +
  'px-4 py-2 text-body font-semibold transition duration-150 ease-out select-none ' +
  'hover:-translate-y-px active:translate-y-px ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0 disabled:active:translate-y-0';

/** A secondary action that sits next to the primary one. */
export const btnSecondary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-edge ' +
  'bg-surface-3 px-3.5 py-2 text-body font-medium text-ink-dim shadow-e1 transition duration-150 ease-out select-none ' +
  'hover:border-ink-dim/50 hover:bg-surface-4 hover:text-ink ' +
  'active:translate-y-px ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-edge disabled:hover:bg-surface-3 disabled:hover:text-ink-dim disabled:hover:shadow-e1 disabled:active:translate-y-0';

/** The quietest control — a link-weight button with no chrome until hover. */
export const btnGhost =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent ' +
  'px-3 py-1.5 text-label font-medium text-ink-dim transition duration-150 ease-out select-none ' +
  'hover:border-edge hover:bg-surface-3 hover:text-ink active:translate-y-px ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-ink-dim disabled:hover:shadow-none disabled:active:translate-y-0';

/* ----- surfaces -------------------------------------------------------- */

/** A static elevated container — a panel that holds a diagram or an editor. */
export const panelSurface =
  'ql-sheen rounded-xl border border-edge bg-surface-2 shadow-e2';

/** A static content card. */
export const card =
  'ql-sheen rounded-xl border border-edge bg-surface-2 p-4 shadow-e1';

/** A card that is also a link or a button: lifts on hover, and its edge lights
 *  up in the stage spectrum (`.ql-ring-spectrum`). */
export const cardInteractive =
  'cell ql-sheen ql-ring-spectrum group block rounded-xl border border-edge bg-surface-2 p-4 shadow-e1 transition duration-150 ease-out ' +
  'hover:-translate-y-0.5 hover:border-transparent hover:shadow-e2 ' +
  'active:translate-y-0';

/* ----- text -------------------------------------------------------------- */

/** The quiet kicker above a page title — a category label, not a banner. Dim
 *  and lowercase on purpose: the wide-tracked all-caps accent version reads as
 *  a template. */
export const eyebrow = 'text-label font-medium text-ink-dim';

/** A small rounded tag — a status, a hint, a count. */
export const pill =
  'inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface-2 ' +
  'px-2.5 py-0.5 text-label text-ink-dim shadow-e1';

/* ----- form fields ---------------------------------------------------- */

/** An `<input>`, `<select>` or `<textarea>`. */
export const inputField =
  'max-w-full rounded-lg border border-edge bg-surface-3 px-2.5 py-1.5 text-body text-ink shadow-e1 transition duration-150 ease-out ' +
  'hover:border-ink-dim/50 focus:border-accent disabled:cursor-not-allowed disabled:opacity-40';

/** One option in a segmented control or radio group. Compose with the
 *  active/inactive suffix. */
export const segBase =
  'inline-flex items-center justify-center rounded-lg border px-3 py-1.5 text-body font-medium select-none ' +
  'transition duration-150 ease-out active:translate-y-px';
export const segOn = 'border-accent/70 bg-accent-soft text-ink shadow-e1';
export const segOff =
  'border-edge text-ink-dim hover:border-ink-dim/50 hover:bg-surface-3 hover:text-ink';

/** A container for segmented radio/option groups. */
export const segmentedTrack =
  'inline-flex items-center gap-1 rounded-xl border border-edge bg-surface-3/50 p-1 shadow-e1';

