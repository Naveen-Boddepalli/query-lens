import { btnGhost, controlLabel, inputField } from '../primitives.ts';

export interface Scenario {
  id: string;
  /** A short name for the menu ("Lost update"). */
  title: string;
  /** One line on what it shows, under the menu. */
  blurb: string;
}

export interface ScenarioPickerProps {
  id: string;
  scenarios: readonly Scenario[];
  /** The loaded scenario, or null once the reader has edited away from every one ("Custom"). */
  value: string | null;
  onPick: (id: string) => void;
  label?: string;
}

const CUSTOM = '';

/**
 * A tool's worked examples as one control (§4.2), replacing a wall of preset buttons. A native select keeps the
 * menu accessible and phone-friendly; the chosen scenario's blurb sits under it, and ‹ › walk the list in order so a
 * lesson can be stepped through without reopening the menu.
 */
export function ScenarioPicker({ id, scenarios, value, onPick, label = 'Scenario' }: ScenarioPickerProps) {
  const at = scenarios.findIndex((s) => s.id === value);
  const chosen = at >= 0 ? scenarios[at] : undefined;
  const blurbId = `${id}-blurb`;
  /** The scenario an arrow loads: wrapping round, and from Custom the first (›) or the last (‹). */
  const neighbour = (delta: number) => {
    const from = at >= 0 ? at : delta > 0 ? -1 : scenarios.length;
    return scenarios[(from + delta + scenarios.length) % scenarios.length];
  };
  const prev = neighbour(-1);
  const next = neighbour(1);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={controlLabel}>
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-1">
        <select
          id={id}
          value={chosen ? chosen.id : CUSTOM}
          onChange={(e) => { if (e.target.value !== CUSTOM) onPick(e.target.value); }}
          aria-describedby={blurbId}
          className={`${inputField} min-w-0 flex-1`}
        >
          {!chosen && (
            <option value={CUSTOM} disabled>
              Custom
            </option>
          )}
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        {/* Named by what they load, not by the picker's label: "Previous: Lost update" says more, and a label lookup
            for the picker then finds the picker alone. */}
        <button
          type="button"
          className={`${btnGhost} px-2!`}
          onClick={() => { if (prev) onPick(prev.id); }}
          aria-label={`Previous: ${prev?.title ?? ''}`}
        >
          ‹
        </button>
        <button
          type="button"
          className={`${btnGhost} px-2!`}
          onClick={() => { if (next) onPick(next.id); }}
          aria-label={`Next: ${next?.title ?? ''}`}
        >
          ›
        </button>
      </div>
      <p id={blurbId} className="text-label text-ink-dim">
        {chosen ? chosen.blurb : 'Your own setup. Pick a scenario to load a worked example.'}
      </p>
    </div>
  );
}
