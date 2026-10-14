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
 *  soft neumorphic shadow, and tactile active press. */
export const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-accent/60 ' +
  'bg-accent/15 px-4 py-2 text-body font-medium text-ink shadow-neu-rest backdrop-blur-sm ' +
  'transition duration-150 ease-out select-none ' +
  'hover:border-accent hover:bg-accent/25 hover:shadow-neu-hover ' +
  'active:translate-y-px active:scale-[0.99] active:bg-accent/35 active:shadow-neu-pressed ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-accent/60 disabled:hover:bg-accent/15 disabled:hover:shadow-neu-rest disabled:active:translate-y-0 disabled:active:scale-100';

/** A secondary action that sits next to the primary one. Tactile extrusion with
 *  translucent glassmorphic layering. */
export const btnSecondary =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-edge ' +
  'bg-surface-2/85 px-3.5 py-2 text-body font-medium text-ink-dim shadow-neu-rest backdrop-blur-sm ' +
  'transition duration-150 ease-out select-none ' +
  'hover:border-ink-dim/50 hover:bg-surface-3 hover:text-ink hover:shadow-neu-hover ' +
  'active:translate-y-px active:scale-[0.99] active:shadow-neu-pressed ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-edge disabled:hover:bg-surface-2/85 disabled:hover:text-ink-dim disabled:hover:shadow-neu-rest disabled:active:translate-y-0 disabled:active:scale-100';

/** The quietest control — a link-weight button with no chrome until hover. */
export const btnGhost =
  'inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent ' +
  'px-3 py-1.5 text-label font-medium text-ink-dim ' +
  'transition duration-150 ease-out select-none ' +
  'hover:border-edge hover:bg-surface-2/70 hover:text-ink hover:shadow-neu-rest hover:backdrop-blur-sm ' +
  'active:translate-y-px active:scale-[0.99] active:shadow-neu-pressed ' +
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-ink-dim disabled:hover:shadow-none disabled:active:translate-y-0 disabled:active:scale-100';

/* ----- surfaces -------------------------------------------------------- */

/** A static elevated container — a panel that holds a diagram or an editor.
 *  Uses frosted glassmorphic surfacing with saturation boost and top sheen. */
export const panelSurface =
  'ql-sheen rounded-xl border border-edge bg-surface-2/80 shadow-e2 backdrop-blur-md backdrop-saturate-180';

/** A static content card with subtle frosted glass layering and soft neumorphic shadow. */
export const card =
  'ql-sheen rounded-xl border border-edge bg-surface-2/85 p-4 shadow-neu-rest backdrop-blur-sm';

/** A card that is also a link or a button: lifts and lights its edge on hover,
 *  with concave debossing on active press. */
export const cardInteractive =
  'cell ql-sheen group block rounded-xl border border-edge bg-surface-2/85 p-4 shadow-neu-rest backdrop-blur-sm ' +
  'transition duration-150 ease-out ' +
  'hover:-translate-y-0.5 hover:border-accent/50 hover:bg-surface-3/90 hover:shadow-neu-hover ' +
  'active:translate-y-px active:scale-[0.995] active:shadow-neu-pressed';

/* ----- text -------------------------------------------------------------- */

/** The quiet kicker above a page title — a category label, not a banner. Dim
 *  and lowercase on purpose: the wide-tracked all-caps accent version reads as
 *  a template. */
export const eyebrow = 'text-label font-medium text-ink-dim';

/** A small rounded tag — a status, a hint, a count. */
export const pill =
  'inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface-2/80 ' +
  'px-2.5 py-0.5 text-label text-ink-dim shadow-neu-rest backdrop-blur-sm';

/* ----- form fields ---------------------------------------------------- */

/** An `<input>`, `<select>` or `<textarea>`. Carved sunken well with focus halo. */
export const inputField =
  'rounded-lg border border-edge bg-surface/80 px-2.5 py-1.5 text-body text-ink shadow-neu-track ' +
  'backdrop-blur-sm transition duration-150 ease-out ' +
  'hover:border-ink-dim/50 focus:border-accent focus:shadow-neu-track ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

/** One option in a segmented control or radio group. Compose with the
 *  active/inactive suffix. */
export const segBase =
  'inline-flex items-center justify-center rounded-lg border px-3 py-1.5 text-body font-medium select-none ' +
  'transition duration-150 ease-out active:translate-y-px active:scale-[0.99]';
export const segOn = 'border-accent bg-accent-soft text-ink shadow-neu-rest backdrop-blur-sm';
export const segOff =
  'border-edge text-ink-dim hover:border-ink-dim/50 hover:bg-surface-3 hover:text-ink hover:shadow-neu-rest';

/** A carved sunken track container for segmented radio/option groups. */
export const segmentedTrack =
  'inline-flex items-center gap-1 rounded-xl border border-edge bg-surface/80 p-1 shadow-neu-track backdrop-blur-sm';
