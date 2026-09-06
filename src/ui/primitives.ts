/**
 * Shared className strings for the redesign's recurring surfaces and controls.
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

/** The one primary action on a view. Translucent-accent fill (a solid accent
 *  would need dark text and fail contrast on the dark theme), crisp border,
 *  and a glow that only appears on hover so a resting page stays calm. */
export const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-accent/60 ' +
  'bg-accent/15 px-4 py-2 text-body font-medium text-ink shadow-e1 transition ' +
  'hover:border-accent hover:bg-accent/25 hover:shadow-glow ' +
  'active:translate-y-px active:bg-accent/40 ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent/15 disabled:hover:shadow-e1';

/** A secondary action that sits next to the primary one. */
export const btnSecondary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-edge ' +
  'bg-surface-3 px-3.5 py-2 text-body text-ink-dim shadow-e1 transition ' +
  'hover:border-ink-dim/50 hover:bg-surface-4 hover:text-ink ' +
  'active:translate-y-px ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

/** The quietest control — a link-weight button with no chrome until hover. */
export const btnGhost =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent ' +
  'px-3 py-1.5 text-label text-ink-dim transition ' +
  'hover:border-edge hover:bg-surface-3 hover:text-ink active:translate-y-px';

/* ----- surfaces -------------------------------------------------------- */

/** A static elevated container — a panel that holds a diagram or an editor. */
export const panelSurface =
  'ql-sheen rounded-xl border border-edge bg-surface-2 shadow-e2';

/** A static content card. */
export const card = 'ql-sheen rounded-xl border border-edge bg-surface-2 p-4 shadow-e1';

/** A card that is also a link or a button: lifts and lights its edge on hover. */
export const cardInteractive =
  'cell ql-sheen group block rounded-xl border border-edge bg-surface-2 p-4 shadow-e1 transition ' +
  'hover:-translate-y-0.5 hover:border-accent/50 hover:bg-surface-3 hover:shadow-e2 ' +
  'active:translate-y-0';

/* ----- text -------------------------------------------------------------- */

/** The small caps label that sits above a page or section title. */
export const eyebrow =
  'text-label font-medium tracking-[0.14em] text-accent uppercase';

/** A small rounded tag — a status, a hint, a count. */
export const pill =
  'inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface-2 ' +
  'px-2.5 py-0.5 text-label text-ink-dim';

/* ----- form fields ---------------------------------------------------- */

/** An `<input>`, `<select>` or `<textarea>`. Focus ring is global. */
export const inputField =
  'rounded-lg border border-edge bg-surface-3 px-2.5 py-1.5 text-body text-ink shadow-e1 ' +
  'transition hover:border-ink-dim/50 disabled:opacity-40';

/** One option in a hand-rolled radio group (Settings). Compose with the
 *  active/inactive suffix. */
export const segBase =
  'rounded-lg border px-3 py-1.5 text-body transition';
export const segOn = 'border-accent bg-accent-soft text-ink shadow-e1';
export const segOff =
  'border-edge text-ink-dim hover:border-ink-dim/50 hover:bg-surface-3 hover:text-ink';
